import { config as loadEnv } from 'dotenv'

loadEnv()

import { fileURLToPath } from 'node:url'
import {
  DefiLlamaClient,
  estimateBlockByTimestamp,
  getChainClient,
  priceCurveLpUsd,
  readVaultSharePrice
} from '../src/clients'
import { createPool, getBatchHistoricalPrices, getExistingExactTimestamps, insertTokenPrices } from '../src/db'
import { ApiError } from '../src/http/errors'
import { createChildMarketSources, marketPriceResolver } from '../src/registries/historical'
import { createDefiLlamaAliasHistoricalSource } from '../src/sources'
import { buildDefiLlamaPayloads } from '../src/sources/defillama/batch'
import { buildDefiLlamaWrites } from '../src/sources/defillama/match'
import { MARKET_PRICE_ADAPTER } from '../src/sources/onchain/engine'
import { isRetryablePricingError, RecursiveDependencyError } from '../src/sources/onchain/errors'
import { OnchainPricer } from '../src/sources/onchain/pricer'
import type {
  MarketPriceResolver,
  PriceInputEvidence,
  PriceResolutionFailure,
  RecursivePriceTarget,
  ResolvedPricePath
} from '../src/sources/onchain/types'
import type { HistoricalRequestTuple, KongVaultListItem, TokenPriceWrite } from '../src/types'
import {
  chainIdToName,
  chainNameToId,
  isTodayNormalized,
  normalizedDaysInRange,
  normalizeToEndOfDay,
  normalizeTokenAddress,
  nowUnix,
  parseCliDate,
  runInGroups,
  toFetchTimestamp
} from '../src/utils'

const stats: WarmupStats = {
  cacheHits: 0,
  apiCalls: 0,
  retries: 0,
  failures: 0,
  insertedDirect: 0,
  onchainWrites: 0,
  insertedDerived: 0,
  insertedCurve: 0,
  onchainRetryable: 0,
  onchainInvalid: 0,
  onchainUnsupported: 0,
  onchainNotFound: 0
}
let pool: ReturnType<typeof createPool>
let defiLlama: DefiLlamaClient

const REQUEST_GROUP_SIZE = 5
const REQUEST_GROUP_DELAY_MS = 200

export interface NormalizedVault {
  chain: string
  chainId: number
  vaultToken: `0x${string}`
  underlyingToken: `0x${string}`
  symbol: string | null
  apiVersion: string | null
  decimals: number
}

export interface WarmupStats {
  cacheHits: number
  apiCalls: number
  retries: number
  failures: number
  insertedDirect: number
  /** Rows handed to the idempotent insert, not rows the insert actually added. */
  onchainWrites: number
  insertedDerived: number
  insertedCurve: number
  onchainRetryable: number
  onchainInvalid: number
  onchainUnsupported: number
  onchainNotFound: number
}

type ResolvedPathNode = ResolvedPricePath | PriceInputEvidence

export type OnchainFailureCategory = 'retryable' | 'invalid' | 'unsupported' | 'not-found'

export type OnchainFailureAttempt = PriceResolutionFailure['attempts'][number] & { token: string }

export interface OnchainFailureReport {
  category: OnchainFailureCategory
  tokenKey: string
  chain: string
  timestamp: number
  /** The token at the bottom of the failure chain; the root itself when it has no priced dependency. */
  deepestFailedToken: string
  attempts: OnchainFailureAttempt[]
}

function parseArgs(argv: string[]): { start: number; end: number } {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = argv[index + 1]
    if (current.startsWith('--') && next) {
      options.set(current, next)
      index += 1
    }
  }

  const defaultEnd = normalizeToEndOfDay(nowUnix())
  const defaultStart = normalizeToEndOfDay(defaultEnd - 6 * 86_400)
  const start = options.has('--start') ? parseCliDate(options.get('--start')!) : defaultStart
  const end = options.has('--end') ? parseCliDate(options.get('--end')!) : defaultEnd

  if (start > end) {
    throw new Error('--start must be <= --end')
  }

  return { start, end }
}

async function fetchYearnVaults(): Promise<NormalizedVault[]> {
  const response = await fetch('https://kong.yearn.fi/api/rest/list/vaults?origin=yearn')
  if (!response.ok) {
    throw new Error(`Failed to fetch Kong vault list: ${response.status}`)
  }

  const json = (await response.json()) as KongVaultListItem[]
  const vaults: NormalizedVault[] = []

  for (const item of json) {
    const chain = chainIdToName(item.chainId)
    if (!chain || !item.asset?.address || !item.decimals) {
      continue
    }

    try {
      vaults.push({
        chain,
        chainId: item.chainId,
        vaultToken: normalizeTokenAddress(item.address),
        underlyingToken: normalizeTokenAddress(item.asset.address),
        symbol: item.symbol,
        apiVersion: item.apiVersion,
        decimals: item.decimals
      })
    } catch {}
  }

  return vaults
}

function buildDailyTimestamps(start: number, end: number): number[] {
  return normalizedDaysInRange(start, end)
}

function buildDirectRequests(vaults: NormalizedVault[], timestamps: number[]): HistoricalRequestTuple[] {
  const tokenMap = new Map<string, { chain: string; token: string }>()
  for (const vault of vaults) {
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

export function flattenResolvedPricePath(path: ResolvedPricePath): ResolvedPathNode[] {
  const nodes: ResolvedPathNode[] = []
  const visit = (node: PriceInputEvidence): void => {
    for (const input of node.inputs ?? []) {
      visit(input)
    }
    nodes.push(node)
  }

  for (const input of path.inputs) {
    visit(input)
  }
  nodes.push(path)
  return nodes
}

export function resolvedPathTokenPriceWrites(path: ResolvedPricePath): TokenPriceWrite[] {
  const writes = new Map<string, TokenPriceWrite>()
  const requestedTimestamp = path.requestedTimestamp ?? path.observedTimestamp

  for (const node of flattenResolvedPricePath(path)) {
    if (node.source === 'db') {
      continue
    }
    const chain = chainIdToName(node.chainId)
    if (!chain) {
      continue
    }
    const marketSourced = node !== path && node.source !== 'derived'
    const timestamp = marketSourced ? normalizeToEndOfDay(node.observedTimestamp) : requestedTimestamp
    const key = `${chain}:${node.token.toLowerCase()}:${timestamp}`
    if (writes.has(key)) {
      continue
    }
    writes.set(key, {
      chain,
      token: node.token,
      timestamp,
      price: node.priceUsd,
      symbol: node.symbol,
      confidence: node.confidence,
      source: node.source
    })
  }

  return [...writes.values()]
}

function failureChain(failure: PriceResolutionFailure): PriceResolutionFailure[] {
  const chain = [failure]
  let current = failure
  while (true) {
    const nested = current.attempts.find((attempt) => attempt.cause instanceof RecursiveDependencyError)
    if (!nested) {
      break
    }
    current = (nested.cause as RecursiveDependencyError).failure
    chain.push(current)
  }
  return chain
}

export function categorizeOnchainFailure(failure: PriceResolutionFailure): OnchainFailureCategory {
  const chain = failureChain(failure)
  if (chain.some((link) => link.reason === 'retryable' || link.reason === 'budget')) {
    return 'retryable'
  }
  if (chain.some((link) => link.reason === 'invalid')) {
    return 'invalid'
  }
  const deepest = chain[chain.length - 1]
  // A market-source miss is the absence of a price, not an adapter refusing the
  // token, so it decides 'not-found' rather than 'unsupported'.
  const adapterAttempts = deepest.attempts.filter((attempt) => attempt.adapter !== MARKET_PRICE_ADAPTER)
  if (deepest.reason === 'unsupported' && adapterAttempts.length === 0) {
    return 'not-found'
  }
  return 'unsupported'
}

export function deepestFailedToken(failure: PriceResolutionFailure): string {
  const chain = failureChain(failure)
  return chain[chain.length - 1].token
}

export function failureAttempts(failure: PriceResolutionFailure): OnchainFailureAttempt[] {
  return failureChain(failure).flatMap((link) => link.attempts.map((attempt) => ({ ...attempt, token: link.token })))
}

function onchainFailureReport(
  chain: string,
  token: string,
  timestamp: number,
  failure: PriceResolutionFailure
): OnchainFailureReport {
  return {
    category: categorizeOnchainFailure(failure),
    tokenKey: `${chain}:${token}`,
    chain,
    timestamp,
    deepestFailedToken: deepestFailedToken(failure),
    attempts: failureAttempts(failure)
  }
}

function inlineOnchainFailureReport(
  category: OnchainFailureCategory,
  request: HistoricalRequestTuple
): OnchainFailureReport {
  return {
    category,
    tokenKey: `${request.chain}:${request.token}`,
    chain: request.chain,
    timestamp: request.timestamp,
    deepestFailedToken: request.token,
    attempts: []
  }
}

function recordOnchainFailure(stats: WarmupStats, category: OnchainFailureCategory): void {
  if (category === 'retryable') {
    stats.onchainRetryable += 1
  } else if (category === 'invalid') {
    stats.onchainInvalid += 1
  } else if (category === 'unsupported') {
    stats.onchainUnsupported += 1
  } else {
    stats.onchainNotFound += 1
  }
}

function printOnchainFailureReport(reports: OnchainFailureReport[]): void {
  if (reports.length === 0) {
    return
  }
  console.warn('On-chain resolution failures:')
  for (const report of reports) {
    console.warn(
      `[${report.category}] token=${report.tokenKey} chain=${report.chain} timestamp=${report.timestamp} deepest=${report.deepestFailedToken}`
    )
    for (const attempt of report.attempts) {
      console.warn(`  ${attempt.token} ${attempt.adapter} (${attempt.reason}): ${attempt.error}`)
    }
  }
}

function groupMissingRequests(requests: HistoricalRequestTuple[], existing: Set<string>): Record<string, number[]> {
  const grouped: Record<string, number[]> = {}

  for (const request of requests) {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    if (existing.has(key) && !isTodayNormalized(request.timestamp)) {
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
  transientFailures: Set<string>
): Promise<void> {
  const requests = buildDirectRequests(vaults, timestamps)
  const existing = await getExistingExactTimestamps(pool, requests, 'defillama')
  stats.cacheHits += [...existing].filter((key) => {
    const timestamp = Number(key.slice(key.lastIndexOf(':') + 1))
    return !isTodayNormalized(timestamp)
  }).length

  const groupedMissing = groupMissingRequests(requests, existing)
  const payloads = buildDefiLlamaPayloads(groupedMissing)

  await runInGroups(payloads, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (payload) => {
    stats.apiCalls += 1
    try {
      const response = await defiLlama.getBatchHistorical(payload)
      const writes: TokenPriceWrite[] = []

      for (const [tokenKey, requestedTimestamps] of Object.entries(payload)) {
        const [chain, token] = tokenKey.split(':')
        const built = buildDefiLlamaWrites(chain, token, requestedTimestamps, response.coins[tokenKey])
        writes.push(...built.writes)
        for (const requestedTimestamp of built.missing) {
          console.warn(`gap:defillama ${tokenKey} ${requestedTimestamp}`)
        }
      }

      await insertTokenPrices(pool, writes)
      stats.insertedDirect += writes.length
    } catch (error) {
      stats.failures += 1
      for (const [tokenKey, fetchTimestamps] of Object.entries(payload)) {
        for (const fetchTimestamp of fetchTimestamps) {
          transientFailures.add(`${tokenKey}:${normalizeToEndOfDay(fetchTimestamp)}`)
        }
      }
      console.error('DeFiLlama batch failed', payload, error)
    }
  })
}

export interface OnchainWarmupDeps {
  pool: typeof pool
  defiLlama: DefiLlamaClient
  getBatch: typeof getBatchHistoricalPrices
  insert: typeof insertTokenPrices
  makePricer: (resolver: MarketPriceResolver) => Pick<OnchainPricer, 'resolvePath' | 'resolvedPaths'>
}

/**
 * A transient alias failure must not reach the engine as absence: the root would
 * then be reported not-found when the price only failed to load.
 */
async function resolveAliasRoot(
  resolver: MarketPriceResolver,
  target: RecursivePriceTarget
): Promise<{ path: ResolvedPricePath | null; retryable: boolean }> {
  try {
    return { path: await resolver(target), retryable: false }
  } catch (error) {
    return { path: null, retryable: error instanceof ApiError || isRetryablePricingError(error) }
  }
}

function defaultOnchainWarmupDeps(): OnchainWarmupDeps {
  return {
    pool,
    defiLlama,
    getBatch: getBatchHistoricalPrices,
    insert: insertTokenPrices,
    makePricer: (resolver) => new OnchainPricer({ marketPrice: resolver, clientForChain: getChainClient })
  }
}

export async function warmOnchainPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
  transientFailures: Set<string>,
  deps: OnchainWarmupDeps = defaultOnchainWarmupDeps()
): Promise<void> {
  const { pool: db, defiLlama: llama, getBatch, insert, makePricer } = deps
  const requests = buildDirectRequests(vaults, timestamps)
  const existing = await getBatch(db, requests)
  const existingKeys = new Set(existing.map((price) => `${price.chain}:${price.token}:${price.timestamp}`))
  const reports: OnchainFailureReport[] = []
  const missing: HistoricalRequestTuple[] = []

  for (const request of requests) {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    if (existingKeys.has(key)) {
      continue
    }
    // Today's slot ends at a moment that has not happened yet. Resolving it
    // would price against a future timestamp and report the gap as missing.
    if (isTodayNormalized(request.timestamp)) {
      continue
    }
    if (transientFailures.has(key)) {
      recordOnchainFailure(stats, 'retryable')
      reports.push(inlineOnchainFailureReport('retryable', request))
      continue
    }
    missing.push(request)
  }

  const resolver = marketPriceResolver(createChildMarketSources(llama, db))
  const aliasResolver = marketPriceResolver([createDefiLlamaAliasHistoricalSource(llama)])

  const persist = async (paths: ResolvedPricePath[]): Promise<void> => {
    const writes = paths.flatMap(resolvedPathTokenPriceWrites)
    if (writes.length === 0) {
      return
    }
    await insert(db, writes)
    stats.onchainWrites += writes.length
  }

  const fail = (category: OnchainFailureCategory, report: OnchainFailureReport): void => {
    reports.push(report)
    recordOnchainFailure(stats, category)
  }

  await runInGroups(missing, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (request) => {
    try {
      const chainId = chainNameToId(request.chain)
      if (chainId === undefined) {
        fail('unsupported', inlineOnchainFailureReport('unsupported', request))
        return
      }
      const target = { chainId, token: request.token, timestamp: request.timestamp }

      // The engine skips market sources at depth 0 and the direct phase is
      // batch-DefiLlama only, so a root has never been tried against the alias.
      const alias = await resolveAliasRoot(aliasResolver, target)
      if (alias.path) {
        await persist([alias.path])
        return
      }
      if (alias.retryable) {
        fail('retryable', inlineOnchainFailureReport('retryable', request))
        return
      }

      const pricer = makePricer(resolver)
      const result = await pricer.resolvePath(target)

      if (!result.path) {
        const report = onchainFailureReport(request.chain, request.token, request.timestamp, result.failure)
        fail(report.category, report)
        // Underlyings that did resolve are still prices worth keeping; the next
        // run reads them from the DB instead of fetching them again.
        await persist(pricer.resolvedPaths())
        return
      }

      await persist([result.path])
    } catch (error) {
      stats.failures += 1
      console.error(
        'On-chain price failed',
        { token: request.token, timestamp: request.timestamp, chain: request.chain },
        error
      )
    }
  })

  printOnchainFailureReport(reports)
}

async function warmCurveFallbackPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats
): Promise<void> {
  // Underlying tokens DefiLlama can't price (e.g. old Curve LP tokens) leave a
  // gap that cascades into derived vault prices. Fill those from the Curve
  // pool's on-chain virtual price.
  const underlyings = new Map<string, { chain: string; chainId: number; token: `0x${string}` }>()
  for (const vault of vaults) {
    underlyings.set(`${vault.chain}:${vault.underlyingToken}`, {
      chain: vault.chain,
      chainId: vault.chainId,
      token: vault.underlyingToken
    })
  }

  const requests: HistoricalRequestTuple[] = []
  for (const underlying of underlyings.values()) {
    for (const timestamp of timestamps) {
      requests.push({ chain: underlying.chain, token: underlying.token, timestamp })
    }
  }

  const [existingDefillama, existingCurve] = await Promise.all([
    getExistingExactTimestamps(pool, requests, 'defillama'),
    getExistingExactTimestamps(pool, requests, 'curve')
  ])
  const missing = requests.filter((request) => {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    return isTodayNormalized(request.timestamp) || (!existingDefillama.has(key) && !existingCurve.has(key))
  })

  await runInGroups(missing, REQUEST_GROUP_SIZE, REQUEST_GROUP_DELAY_MS, async (request) => {
    try {
      const underlying = underlyings.get(`${request.chain}:${request.token}`)!

      const client = getChainClient(underlying.chainId)
      if (!client) {
        console.warn(`gap:missing-rpc chainId=${underlying.chainId}`)
        return
      }

      const blockNumber = await estimateBlockByTimestamp(client, underlying.chainId, request.timestamp)

      const price = await priceCurveLpUsd(client, underlying.chainId, underlying.token, blockNumber, async (coin) => {
        const coinKey = `${request.chain}:${coin}`
        stats.apiCalls += 1
        const response = await defiLlama.getHistorical(toFetchTimestamp(request.timestamp, nowUnix()), [coinKey])
        return response.coins[coinKey]?.price ?? null
      })

      if (price == null) {
        console.warn(`gap:curve ${request.chain}:${request.token} ${request.timestamp}`)
        return
      }

      await insertTokenPrices(pool, [
        {
          chain: request.chain,
          token: request.token,
          timestamp: request.timestamp,
          price,
          symbol: null,
          confidence: null,
          source: 'curve'
        }
      ])
      stats.insertedCurve += 1
    } catch (error) {
      stats.failures += 1
      console.error('Curve fallback failed', { token: request.token, timestamp: request.timestamp }, error)
    }
  })
}

async function warmDerivedVaultPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats
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

  const existingDerived = await getExistingExactTimestamps(pool, derivedRequests, 'derived')
  const missingVaults = vaults.flatMap((vault) => {
    return timestamps
      .filter(
        (timestamp) =>
          isTodayNormalized(timestamp) || !existingDerived.has(`${vault.chain}:${vault.vaultToken}:${timestamp}`)
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
        console.warn(`gap:derived-underlying ${vault.chain}:${vault.underlyingToken} ${timestamp}`)
        return
      }

      const client = getChainClient(vault.chainId)
      if (!client) {
        console.warn(`gap:missing-rpc chainId=${vault.chainId}`)
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
      await insertTokenPrices(pool, [
        {
          chain: vault.chain,
          token: vault.vaultToken,
          timestamp,
          price: derivedPrice,
          symbol: vault.symbol,
          confidence: null,
          source: 'derived'
        }
      ])
      stats.insertedDerived += 1
    } catch (error) {
      stats.failures += 1
      console.error('Derived vault price failed', { vault: vault.vaultToken, timestamp, chainId: vault.chainId }, error)
    }
  })
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }
  pool = createPool(databaseUrl)
  defiLlama = new DefiLlamaClient(undefined, () => {
    stats.retries += 1
  })

  try {
    const { start, end } = parseArgs(process.argv.slice(2))
    const timestamps = buildDailyTimestamps(start, end)
    const vaults = await fetchYearnVaults()

    console.info(`Warmup start: ${timestamps.length} days, ${vaults.length} vaults`)
    const directTransientFailures = new Set<string>()
    await warmDirectPrices(vaults, timestamps, stats, directTransientFailures)
    await warmOnchainPrices(vaults, timestamps, stats, directTransientFailures)
    await warmCurveFallbackPrices(vaults, timestamps, stats)
    await warmDerivedVaultPrices(vaults, timestamps, stats)

    console.info(
      JSON.stringify({
        message: 'warmup-complete',
        range: { start, end },
        timestamps: timestamps.length,
        vaults: vaults.length,
        ...stats
      })
    )
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
