import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv()

import { BaseError, ContractFunctionZeroDataError, parseAbi } from 'viem'
import { parseManifest } from '../src/backfill/manifest'
import { estimateBlockByTimestamp, getChainClient, priceCurveLpUsd, readVaultSharePrice } from '../src/clients'
import {
  createPool,
  finalizeTokenPrices,
  getBatchHistoricalPrices,
  getExistingExactTimestamps,
  getUnfinalizedExactTimestamps,
  insertProvisionalTokenPrices
} from '../src/db'
import { isRejectedPrice } from '../src/prices/rejections'
import { DEFILLAMA_UNSUPPORTED_CHAINS } from '../src/sources'
import {
  CHAINLINK_ETH_QUOTED_FEEDS,
  CHAINLINK_FEEDS,
  createChainlinkHistoricalSource,
  getChainlinkEthQuotedFeed,
  getChainlinkFeed
} from '../src/sources/chainlink'
import { buildDefiLlamaPayloads } from '../src/sources/defillama/batch'
import { buildDefiLlamaWrites, matchPricesToRequests } from '../src/sources/defillama/match'
import type { HistoricalRequestTuple, TokenPriceWrite } from '../src/types'
import {
  chainIdToName,
  chainNameToId,
  isClosedDay,
  isTodayNormalized,
  normalizedDaysInRange,
  normalizeToEndOfDay,
  normalizeTokenAddress,
  nowUnix,
  parseCliDate,
  runInGroups,
  toFetchTimestamp
} from '../src/utils'
import { plausibleWrites, storedCurveLpGuard } from './lib/curve-lp-guard'
import { runGraphBackfill } from './lib/graph-backfill'
import { fetchYearnVaults, type NormalizedVault } from './lib/kong-vaults'
import { offlineProvider } from './lib/offline-provider'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const pool = createPool(databaseUrl)
const quiet = process.argv.includes('--quiet')
const gap = (message: string) => {
  if (!quiet) console.warn(message)
}
const stats: WarmupStats = {
  cacheHits: 0,
  apiCalls: 0,
  retries: 0,
  failures: 0,
  insertedDirect: 0,
  insertedDerived: 0,
  insertedCurve: 0,
  insertedChainlink: 0,
  insertedGraph: 0,
  rejectedImplausible: 0
}
const defiLlama = offlineProvider(1, {
  allowIntraday: true,
  onRetry: () => {
    stats.retries += 1
  }
})
const chainlink = createChainlinkHistoricalSource()
const curveLpGuard = storedCurveLpGuard(pool)

const REQUEST_GROUP_SIZE = 5
const REQUEST_GROUP_DELAY_MS = 200
const ERC20_SYMBOL_ABI = parseAbi(['function symbol() view returns (string)'])
const tokenSymbols = new Map<string, Promise<string | null>>()

function tokenSymbol(chainId: number, token: `0x${string}`): Promise<string | null> {
  const key = `${chainId}:${token}`
  const cached = tokenSymbols.get(key)
  if (cached) {
    return cached
  }
  const pending = (async () => {
    const client = getChainClient(chainId)
    if (!client) {
      return null
    }
    try {
      return await client.readContract({ address: token, abi: ERC20_SYMBOL_ABI, functionName: 'symbol' })
    } catch {
      return null
    }
  })()
  tokenSymbols.set(key, pending)
  return pending
}

interface WarmupStats {
  cacheHits: number
  apiCalls: number
  retries: number
  failures: number
  insertedDirect: number
  insertedDerived: number
  insertedCurve: number
  insertedChainlink: number
  insertedGraph: number
  rejectedImplausible: number
}

function parseChain(value: string): number {
  const asNumber = Number(value)
  if (Number.isInteger(asNumber) && chainIdToName(asNumber)) {
    return asNumber
  }
  const fromName = chainNameToId(value)
  if (fromName !== undefined) {
    return fromName
  }
  throw new Error(`Unknown chain: ${value}`)
}

function parseArgs(argv: string[]): { start: number; end: number; chainId: number | undefined; graph: boolean } {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = argv[index + 1]
    if (current === '--graph' || current === '--quiet') continue
    if (current.startsWith('--') && next) {
      options.set(current, next)
      index += 1
    }
  }

  const defaultEnd = normalizeToEndOfDay(nowUnix())
  const defaultStart = normalizeToEndOfDay(defaultEnd - 6 * 86_400)
  const start = options.has('--start') ? parseCliDate(options.get('--start')!) : defaultStart
  const end = options.has('--end') ? parseCliDate(options.get('--end')!) : defaultEnd
  const chainId = options.has('--chain') ? parseChain(options.get('--chain')!) : undefined

  if (start > end) {
    throw new Error('--start must be <= --end')
  }

  return { start, end, chainId, graph: argv.includes('--graph') }
}

function chainlinkFeedVaults(chainId: number): NormalizedVault[] {
  const chain = chainIdToName(chainId)
  if (!chain) {
    throw new Error(`Unknown chain id: ${chainId}`)
  }
  const feeds = { ...CHAINLINK_FEEDS[chainId], ...CHAINLINK_ETH_QUOTED_FEEDS[chainId] }
  return Object.keys(feeds).map((token) => {
    const address = normalizeTokenAddress(token)
    return {
      chain,
      chainId,
      vaultToken: address,
      underlyingToken: address,
      symbol: null,
      apiVersion: null,
      decimals: 18,
      isRetired: false,
      isHidden: false,
      tvl: 0
    }
  })
}

function buildDailyTimestamps(start: number, end: number): number[] {
  return normalizedDaysInRange(start, end)
}

function buildDirectRequests(vaults: NormalizedVault[], timestamps: number[]): HistoricalRequestTuple[] {
  const tokenMap = new Map<string, { chain: string; token: string }>()
  for (const vault of vaults) {
    if (DEFILLAMA_UNSUPPORTED_CHAINS.has(vault.chainId)) continue
    tokenMap.set(`${vault.chain}:${vault.underlyingToken}`, {
      chain: vault.chain,
      token: vault.underlyingToken
    })
    tokenMap.set(`${vault.chain}:${vault.vaultToken}`, {
      chain: vault.chain,
      token: vault.vaultToken
    })
  }

  const requests: HistoricalRequestTuple[] = []
  for (const token of tokenMap.values()) {
    for (const timestamp of timestamps) {
      requests.push({ ...token, timestamp })
    }
  }
  return requests
}

function groupMissingRequests(
  requests: HistoricalRequestTuple[],
  existing: Set<string>,
  unfinalized: Set<string>,
  requestTime: number
): Record<string, number[]> {
  const grouped: Record<string, number[]> = {}

  for (const request of requests) {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    if (existing.has(key) && !unfinalized.has(key) && !isTodayNormalized(request.timestamp, requestTime)) {
      continue
    }

    const tokenKey = `${request.chain}:${request.token}`
    grouped[tokenKey] ??= []
    grouped[tokenKey].push(request.timestamp)
  }

  return grouped
}

async function warmDirectPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
  requestTime: number
): Promise<void> {
  const requests = buildDirectRequests(vaults, timestamps)
  const [existing, unfinalized] = await Promise.all([
    getExistingExactTimestamps(pool, requests, 'defillama'),
    getUnfinalizedExactTimestamps(pool, requests, 'defillama')
  ])
  stats.cacheHits += [...existing].filter((key) => {
    const timestamp = Number(key.slice(key.lastIndexOf(':') + 1))
    return !isTodayNormalized(timestamp, requestTime)
  }).length

  const groupedMissing = groupMissingRequests(requests, existing, unfinalized, requestTime)
  const payloads = buildDefiLlamaPayloads(groupedMissing, requestTime)

  await runInGroups(payloads, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (payload) => {
    try {
      const writes: TokenPriceWrite[] = []
      const byFetchTimestamp = new Map<number, string[]>()
      for (const [tokenKey, fetchTimestamps] of Object.entries(payload)) {
        for (const fetchTimestamp of fetchTimestamps) {
          byFetchTimestamp.set(fetchTimestamp, [...(byFetchTimestamp.get(fetchTimestamp) ?? []), tokenKey])
        }
      }

      const lookups = [...byFetchTimestamp].flatMap(([fetchTimestamp, coins]) =>
        coins.map((coin) => ({ coin, result: defiLlama.getHistorical(fetchTimestamp, [coin]) }))
      )
      const settled = await Promise.allSettled(lookups.map(({ result }) => result))
      const failedTokens = new Set<string>()
      const responses = []
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === 'fulfilled') {
          responses.push({ response: outcome.value })
          continue
        }
        failedTokens.add(lookups[index].coin)
        stats.failures += 1
        console.error('DeFiLlama lookup failed', lookups[index].coin, outcome.reason)
      }
      const samplesByToken = new Map<string, Array<{ timestamp: number; price: number; confidence?: number | null }>>()
      const symbolByToken = new Map<string, string | null>()
      for (const { response } of responses) {
        for (const [tokenKey, observation] of Object.entries(response.coins)) {
          const samples = samplesByToken.get(tokenKey) ?? []
          samples.push({
            timestamp: observation.timestamp,
            price: observation.price,
            confidence: observation.confidence
          })
          samplesByToken.set(tokenKey, samples)
          symbolByToken.set(tokenKey, observation.symbol ?? null)
        }
      }

      for (const [tokenKey, requestedTimestamps] of Object.entries(payload)) {
        if (failedTokens.has(tokenKey)) continue
        const [chain, token] = tokenKey.split(':')
        const built = buildDefiLlamaWrites(chain, token, requestedTimestamps, {
          symbol: symbolByToken.get(tokenKey),
          prices: samplesByToken.get(tokenKey) ?? []
        })
        writes.push(
          ...built.writes.map((row) => ({
            ...row,
            finalizationIntent: isTodayNormalized(row.timestamp, requestTime)
              ? ('provisional' as const)
              : ('finalized' as const)
          }))
        )
        for (const requestedTimestamp of built.missing) {
          gap(`gap:defillama ${tokenKey} ${requestedTimestamp}`)
        }
      }

      const { writes: plausible, rejected } = await plausibleWrites(writes, curveLpGuard)
      stats.rejectedImplausible += rejected.length
      await persistWarmupWrites(plausible)
      stats.insertedDirect += plausible.length
    } catch (error) {
      stats.failures += 1
      console.error('DeFiLlama batch failed', payload, error)
    }
  })
}

async function persistWarmupWrites(rows: TokenPriceWrite[]): Promise<void> {
  const provisional = rows.filter((row) => row.finalizationIntent === 'provisional')
  const finalized = rows.filter((row) => row.finalizationIntent === 'finalized')
  if (provisional.length + finalized.length !== rows.length) {
    throw new Error('Warmup writes require an explicit finalization intent')
  }
  await insertProvisionalTokenPrices(pool, provisional)
  await finalizeTokenPrices(pool, finalized)
}

function collectUnderlyings(
  vaults: NormalizedVault[]
): Map<string, { chain: string; chainId: number; token: `0x${string}` }> {
  const underlyings = new Map<string, { chain: string; chainId: number; token: `0x${string}` }>()
  for (const vault of vaults) {
    underlyings.set(`${vault.chain}:${vault.underlyingToken}`, {
      chain: vault.chain,
      chainId: vault.chainId,
      token: vault.underlyingToken
    })
  }
  return underlyings
}

async function warmChainlinkPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
  requestTime: number
): Promise<void> {
  const underlyings = collectUnderlyings(vaults)

  const requests: HistoricalRequestTuple[] = []
  for (const underlying of underlyings.values()) {
    if (
      !getChainlinkFeed(underlying.chainId, underlying.token) &&
      !getChainlinkEthQuotedFeed(underlying.chainId, underlying.token)
    )
      continue
    for (const timestamp of timestamps) {
      requests.push({ chain: underlying.chain, token: underlying.token, timestamp })
    }
  }

  const [existingDefillama, existingChainlink, unfinalizedDefillama, unfinalizedChainlink] = await Promise.all([
    getExistingExactTimestamps(pool, requests, 'defillama'),
    getExistingExactTimestamps(pool, requests, 'chainlink'),
    getUnfinalizedExactTimestamps(pool, requests, 'defillama'),
    getUnfinalizedExactTimestamps(pool, requests, 'chainlink')
  ])
  const missing = requests.filter((request) => {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    return (
      isTodayNormalized(request.timestamp, requestTime) ||
      unfinalizedDefillama.has(key) ||
      unfinalizedChainlink.has(key) ||
      (!existingDefillama.has(key) && !existingChainlink.has(key))
    )
  })

  await runInGroups(missing, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (request) => {
    try {
      const underlying = underlyings.get(`${request.chain}:${request.token}`)!
      const result = await chainlink.getHistoricalPrice(underlying.chainId, underlying.token, request.timestamp)

      if (result == null) {
        gap(`gap:chainlink ${request.chain}:${request.token} ${request.timestamp}`)
        return
      }

      const symbol = await tokenSymbol(underlying.chainId, underlying.token)
      await persistWarmupWrites([
        {
          chain: request.chain,
          token: request.token,
          timestamp: request.timestamp,
          price: result.price,
          symbol,
          confidence: null,
          source: 'chainlink',
          observedTimestamp: result.timestamp,
          observationEndpoint: 'chainlink.getRoundData',
          finalizationIntent: isTodayNormalized(request.timestamp, requestTime) ? 'provisional' : 'finalized'
        }
      ])
      stats.insertedChainlink += 1
    } catch (error) {
      stats.failures += 1
      console.error('Chainlink fallback failed', { token: request.token, timestamp: request.timestamp }, error)
    }
  })
}

async function warmCurveFallbackPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
  requestTime: number
): Promise<void> {
  // Underlying tokens DefiLlama can't price (e.g. old Curve LP tokens) leave a
  // gap that cascades into derived vault prices. Fill those from the Curve
  // pool's on-chain virtual price.
  const underlyings = collectUnderlyings(vaults)

  const requests: HistoricalRequestTuple[] = []
  for (const underlying of underlyings.values()) {
    for (const timestamp of timestamps) {
      requests.push({ chain: underlying.chain, token: underlying.token, timestamp })
    }
  }

  const [existingDefillama, existingCurve, existingChainlink] = await Promise.all([
    getExistingExactTimestamps(pool, requests, 'defillama'),
    getExistingExactTimestamps(pool, requests, 'curve'),
    getExistingExactTimestamps(pool, requests, 'chainlink')
  ])
  const [unfinalizedDefillama, unfinalizedCurve, unfinalizedChainlink] = await Promise.all([
    getUnfinalizedExactTimestamps(pool, requests, 'defillama'),
    getUnfinalizedExactTimestamps(pool, requests, 'curve'),
    getUnfinalizedExactTimestamps(pool, requests, 'chainlink')
  ])
  const missing = requests.filter((request) => {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    return (
      isTodayNormalized(request.timestamp, requestTime) ||
      unfinalizedDefillama.has(key) ||
      unfinalizedCurve.has(key) ||
      unfinalizedChainlink.has(key) ||
      (!existingDefillama.has(key) && !existingCurve.has(key) && !existingChainlink.has(key))
    )
  })

  await runInGroups(missing, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (request) => {
    try {
      const underlying = underlyings.get(`${request.chain}:${request.token}`)!

      const client = getChainClient(underlying.chainId)
      if (!client) {
        gap(`gap:missing-rpc chainId=${underlying.chainId}`)
        return
      }

      const blockNumber = await estimateBlockByTimestamp(client, underlying.chainId, request.timestamp)

      const dependencies: Array<{ timestamp: number; endpoint: string }> = []
      const price = await priceCurveLpUsd(client, underlying.chainId, underlying.token, blockNumber, async (coin) => {
        const coinKey = `${request.chain}:${coin}`
        const fetchTimestamp = toFetchTimestamp(request.timestamp, requestTime)
        const response = await defiLlama.getHistorical(fetchTimestamp, [coinKey])
        const observation = response.coins[coinKey]
        if (!observation) return null

        const matched = matchPricesToRequests([fetchTimestamp], [observation])
        const sample = matched.get(fetchTimestamp)
        if (!sample || !Number.isSafeInteger(sample.timestamp) || !Number.isFinite(sample.price) || sample.price <= 0)
          return null
        if (Math.abs(sample.timestamp - fetchTimestamp) > 6 * 60 * 60) {
          gap(`invalid:curve-dependency-time ${coinKey} requested=${fetchTimestamp} observed=${sample.timestamp}`)
          return null
        }
        if (isRejectedPrice(request.chain, coin, request.timestamp, 'defillama')) {
          gap(`quarantined:curve-dependency ${coinKey} ${request.timestamp}`)
          return null
        }

        dependencies.push({ timestamp: sample.timestamp, endpoint: defiLlama.endpoint })
        return sample.price
      })

      if (price == null) {
        gap(`gap:curve ${request.chain}:${request.token} ${request.timestamp}`)
        return
      }

      const dependency = dependencies[0]

      await persistWarmupWrites([
        {
          chain: request.chain,
          token: request.token,
          timestamp: request.timestamp,
          price,
          symbol: null,
          confidence: null,
          source: 'curve',
          observedTimestamp: dependency?.timestamp ?? null,
          observationEndpoint: dependency?.endpoint ?? 'curve.get_virtual_price',
          finalizationIntent: isTodayNormalized(request.timestamp, requestTime) ? 'provisional' : 'finalized'
        }
      ])
      stats.insertedCurve += 1
    } catch (error) {
      stats.failures += 1
      console.error('Curve fallback failed', { token: request.token, timestamp: request.timestamp }, error)
    }
  })
}

const GRAPH_BUDGET_MS = 45 * 60_000

async function warmGraphFallbackPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats
): Promise<void> {
  const deadline = Date.now() + GRAPH_BUDGET_MS
  const underlyings = [...collectUnderlyings(vaults).values()]
  const days = timestamps.filter((timestamp) => isClosedDay(timestamp)).sort((a, b) => b - a)
  const directory = mkdtempSync(join(tmpdir(), 'warmup-graph-'))
  for (const eodTimestamp of days) {
    if (Date.now() > deadline) {
      stats.failures += 1
      console.error(`Graph fallback budget exhausted before ${eodTimestamp}`)
      return
    }
    const targets = underlyings.map((underlying) => ({
      chainId: underlying.chainId,
      token: underlying.token,
      eodTimestamp
    }))
    const out = join(directory, `${eodTimestamp}.jsonl`)
    try {
      const summary = await runGraphBackfill({
        pool,
        manifest: parseManifest(JSON.stringify({ version: 1, targets })),
        out,
        write: true,
        concurrency: 8,
        providerRps: 1,
        provider: defiLlama
      })
      stats.insertedGraph += summary.inserted
      stats.rejectedImplausible += summary.rejectedImplausible
      const replayFile = `${out}.replay.jsonl`
      const blockedBy = new Map<string, string>()
      if (existsSync(replayFile)) {
        for (const line of readFileSync(replayFile, 'utf8').trim().split('\n')) {
          const record = line ? JSON.parse(line) : null
          const dependency = record?.type === 'target' && record.failure?.attempts?.[0]?.dependency?.token
          if (dependency) blockedBy.set(`${record.target.chainId}:${record.target.token.toLowerCase()}`, dependency)
        }
      }
      for (const line of readFileSync(out, 'utf8').trim().split('\n')) {
        const record = JSON.parse(line)
        if (record.type !== 'target-outcome' || (record.status !== 'unresolved' && record.status !== 'rejected'))
          continue
        if (record.reason === 'retryable') stats.failures += 1
        const blocker = blockedBy.get(`${record.target.chainId}:${record.target.token.toLowerCase()}`)
        gap(
          `gap:graph ${record.target.chain}:${record.target.token} ${record.target.eodTimestamp} ${record.reason}${
            blocker ? ` blocked-by:${blocker}` : ''
          }`
        )
      }
    } catch (error) {
      stats.failures += 1
      console.error('Graph fallback failed', { out }, error)
    }
  }
}

async function warmDerivedVaultPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
  requestTime: number
): Promise<void> {
  const derivedRequests: HistoricalRequestTuple[] = []
  for (const vault of vaults) {
    for (const timestamp of timestamps) {
      derivedRequests.push({
        chain: vault.chain,
        token: vault.vaultToken,
        timestamp
      })
    }
  }

  const [existingDerived, unfinalizedDerived] = await Promise.all([
    getExistingExactTimestamps(pool, derivedRequests, 'derived'),
    getUnfinalizedExactTimestamps(pool, derivedRequests, 'derived')
  ])
  const missingVaults = vaults.flatMap((vault) => {
    return timestamps
      .filter(
        (timestamp) =>
          isTodayNormalized(timestamp, requestTime) ||
          unfinalizedDerived.has(`${vault.chain}:${vault.vaultToken}:${timestamp}`) ||
          !existingDerived.has(`${vault.chain}:${vault.vaultToken}:${timestamp}`)
      )
      .map((timestamp) => ({ vault, timestamp }))
  })

  const underlyingRequests: HistoricalRequestTuple[] = missingVaults.map(({ vault, timestamp }) => ({
    chain: vault.chain,
    token: vault.underlyingToken,
    timestamp
  }))

  const underlyingPrices = await getBatchHistoricalPrices(pool, underlyingRequests)
  const underlyingMap = new Map(
    underlyingPrices.map((price) => [`${price.chain}:${price.token}:${price.timestamp}`, price])
  )

  await runInGroups(missingVaults, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async ({ vault, timestamp }) => {
    try {
      const underlying = underlyingMap.get(`${vault.chain}:${vault.underlyingToken}:${timestamp}`)
      if (!underlying) {
        gap(`gap:derived-underlying ${vault.chain}:${vault.underlyingToken} ${timestamp}`)
        return
      }

      const client = getChainClient(vault.chainId)
      if (!client) {
        gap(`gap:missing-rpc chainId=${vault.chainId}`)
        return
      }

      const blockNumber = await estimateBlockByTimestamp(client, vault.chainId, timestamp)

      const sharePrice = await readVaultSharePrice(
        client,
        vault.vaultToken,
        vault.decimals,
        vault.apiVersion,
        blockNumber
      )

      const derivedPrice = underlying.price * sharePrice
      if (!Number.isFinite(derivedPrice) || derivedPrice <= 0) {
        gap(`gap:derived-invalid-price ${vault.chain}:${vault.vaultToken} ${timestamp} sharePrice=${sharePrice}`)
        return
      }
      await persistWarmupWrites([
        {
          chain: vault.chain,
          token: vault.vaultToken,
          timestamp,
          price: derivedPrice,
          symbol: vault.symbol,
          confidence: null,
          source: 'derived',
          observedTimestamp: underlying.observedTimestamp ?? null,
          observationEndpoint: underlying.observationEndpoint ?? 'onchain.readVaultSharePrice',
          finalizationIntent: isTodayNormalized(timestamp, requestTime) ? 'provisional' : 'finalized'
        }
      ])
      stats.insertedDerived += 1
    } catch (error) {
      if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError)) {
        gap(`gap:derived-vault-not-deployed ${vault.chain}:${vault.vaultToken} ${timestamp}`)
        return
      }
      stats.failures += 1
      console.error('Derived vault price failed', { vault: vault.vaultToken, timestamp, chainId: vault.chainId }, error)
    }
  })
}

try {
  const { start, end, chainId, graph } = parseArgs(process.argv.slice(2))
  const timestamps = buildDailyTimestamps(start, end)
  const vaults = chainId !== undefined ? chainlinkFeedVaults(chainId) : await fetchYearnVaults()
  const requestTime = nowUnix()

  if (!quiet) console.info(`Warmup start: ${timestamps.length} days, ${vaults.length} vaults`)
  if (chainId !== undefined) {
    await warmChainlinkPrices(vaults, timestamps, stats, requestTime)
  } else {
    await warmDirectPrices(vaults, timestamps, stats, requestTime)
    await warmChainlinkPrices(vaults, timestamps, stats, requestTime)
    await warmCurveFallbackPrices(vaults, timestamps, stats, requestTime)
    if (graph) await warmGraphFallbackPrices(vaults, timestamps, stats)
    await warmDerivedVaultPrices(vaults, timestamps, stats, requestTime)
  }

  stats.apiCalls = defiLlama.stats.batchRequests

  console.info(
    JSON.stringify({
      message: 'warmup-complete',
      range: { start, end },
      timestamps: timestamps.length,
      vaults: vaults.length,
      ...stats
    })
  )
  if (stats.failures > 0) process.exitCode = 1
} finally {
  await pool.end()
}
