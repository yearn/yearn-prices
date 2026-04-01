import { config as loadEnv } from 'dotenv'
loadEnv();
import { chainIdToName, normalizeTokenAddress } from "../src/chains";
import { createPool } from '../src/db'
import { DefiLlamaClient } from '../src/defillama'
import {
  getBatchHistoricalPrices,
  getExistingExactTimestamps,
  insertTokenPrices,
} from "../src/queries";
import { createChainClient, estimateBlockByTimestamp, readVaultSharePrice } from '../src/rpc'
import {
  normalizedDaysInRange,
  normalizeToEndOfDay,
  nowUnix,
  parseCliDate,
} from "../src/time";
import type { HistoricalRequestTuple, KongVaultListItem, TokenPriceWrite } from '../src/types'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const pool = createPool(databaseUrl)
const stats: WarmupStats = {
  cacheHits: 0,
  apiCalls: 0,
  retries: 0,
  failures: 0,
  insertedDirect: 0,
  insertedDerived: 0,
}
const defiLlama = new DefiLlamaClient(undefined, () => {
  stats.retries += 1
})

const REQUEST_GROUP_SIZE = 5
const REQUEST_GROUP_DELAY_MS = 200
const DEFI_LLAMA_TOKEN_BATCH = 5
const DEFI_LLAMA_TIMESTAMP_BATCH = 20

interface NormalizedVault {
  chain: string
  chainId: number
  vaultToken: `0x${string}`
  underlyingToken: `0x${string}`
  symbol: string | null
  apiVersion: string | null
  decimals: number
}

interface WarmupStats {
  cacheHits: number
  apiCalls: number
  retries: number
  failures: number
  insertedDirect: number
  insertedDerived: number
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
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

  const json = await response.json() as KongVaultListItem[]
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
        decimals: item.decimals,
      })
    } catch {
      continue
    }
  }

  return vaults
}

function buildDailyTimestamps(start: number, end: number): number[] {
  return normalizedDaysInRange(start, end)
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

async function runInGroups<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  for (const group of chunk(items, REQUEST_GROUP_SIZE)) {
    await Promise.all(group.map(item => worker(item)))
    if (group.length === REQUEST_GROUP_SIZE) {
      await sleep(REQUEST_GROUP_DELAY_MS)
    }
  }
}

function buildDirectRequests(vaults: NormalizedVault[], timestamps: number[]): HistoricalRequestTuple[] {
  const tokenMap = new Map<string, { chain: string; token: string }>()
  for (const vault of vaults) {
    tokenMap.set(`${vault.chain}:${vault.underlyingToken}`, {
      chain: vault.chain,
      token: vault.underlyingToken,
    })
    tokenMap.set(`${vault.chain}:${vault.vaultToken}`, {
      chain: vault.chain,
      token: vault.vaultToken,
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

function groupMissingRequests(requests: HistoricalRequestTuple[], existing: Set<string>): Record<string, number[]> {
  const grouped: Record<string, number[]> = {}

  for (const request of requests) {
    const key = `${request.chain}:${request.token}:${request.timestamp}`
    if (existing.has(key)) {
      continue
    }

    const tokenKey = `${request.chain}:${request.token}`
    grouped[tokenKey] ??= []
    grouped[tokenKey].push(request.timestamp)
  }

  return grouped
}

function buildDefiLlamaPayloads(grouped: Record<string, number[]>): Array<Record<string, number[]>> {
  const tokenChunks: Array<{ tokenKey: string; timestamps: number[] }> = []
  for (const [tokenKey, timestamps] of Object.entries(grouped)) {
    for (const timestampChunk of chunk([...new Set(timestamps)].sort((left, right) => left - right), DEFI_LLAMA_TIMESTAMP_BATCH)) {
      tokenChunks.push({ tokenKey, timestamps: timestampChunk })
    }
  }

  return chunk(tokenChunks, DEFI_LLAMA_TOKEN_BATCH).map(group => {
    return Object.fromEntries(group.map(item => [item.tokenKey, item.timestamps]))
  })
}

async function warmDirectPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
): Promise<void> {
  const requests = buildDirectRequests(vaults, timestamps)
  const existing = await getExistingExactTimestamps(pool, requests, 'defillama')
  stats.cacheHits += existing.size

  const groupedMissing = groupMissingRequests(requests, existing)
  const payloads = buildDefiLlamaPayloads(groupedMissing)

  await runInGroups(payloads, async payload => {
    stats.apiCalls += 1
    try {
      const response = await defiLlama.getBatchHistorical(payload)
      const writes: TokenPriceWrite[] = []

      for (const [tokenKey, requestedTimestamps] of Object.entries(payload)) {
        const responseCoin = response.coins[tokenKey]
        const returnedTimestamps = new Set<number>()

        if (responseCoin) {
          for (const price of responseCoin.prices) {
            returnedTimestamps.add(normalizeToEndOfDay(price.timestamp))
            const [chain, token] = tokenKey.split(':')
            writes.push({
              chain,
              token,
              timestamp: normalizeToEndOfDay(price.timestamp),
              price: price.price,
              symbol: responseCoin.symbol ?? null,
              confidence: price.confidence ?? null,
              source: 'defillama',
            })
          }
        }

        for (const requestedTimestamp of requestedTimestamps) {
          if (!returnedTimestamps.has(requestedTimestamp)) {
            console.warn(`gap:defillama ${tokenKey} ${requestedTimestamp}`)
          }
        }
      }

      await insertTokenPrices(pool, writes)
      stats.insertedDirect += writes.length
    } catch (error) {
      stats.failures += 1
      console.error('DeFiLlama batch failed', payload, error)
    }
  })
}

async function warmDerivedVaultPrices(
  vaults: NormalizedVault[],
  timestamps: number[],
  stats: WarmupStats,
): Promise<void> {
  const rpcClients = new Map<number, ReturnType<typeof createChainClient>>()
  const blockNumbers = new Map<string, bigint>()

  const derivedRequests: HistoricalRequestTuple[] = []
  for (const vault of vaults) {
    for (const timestamp of timestamps) {
      derivedRequests.push({
        chain: vault.chain,
        token: vault.vaultToken,
        timestamp,
      })
    }
  }

  const existingDerived = await getExistingExactTimestamps(pool, derivedRequests, 'derived')
  const missingVaults = vaults.flatMap(vault => {
    return timestamps
      .filter(timestamp => !existingDerived.has(`${vault.chain}:${vault.vaultToken}:${timestamp}`))
      .map(timestamp => ({ vault, timestamp }))
  })

  const underlyingRequests: HistoricalRequestTuple[] = missingVaults.map(({ vault, timestamp }) => ({
    chain: vault.chain,
    token: vault.underlyingToken,
    timestamp,
  }))

  const underlyingPrices = await getBatchHistoricalPrices(pool, underlyingRequests)
  const underlyingMap = new Map(
    underlyingPrices.map(price => [`${price.chain}:${price.token}:${price.timestamp}`, price]),
  )

  await runInGroups(missingVaults, async ({ vault, timestamp }) => {
    const underlying = underlyingMap.get(`${vault.chain}:${vault.underlyingToken}:${timestamp}`)
    if (!underlying) {
      console.warn(`gap:derived-underlying ${vault.chain}:${vault.underlyingToken} ${timestamp}`)
      return
    }

    const rpcUrl = process.env[`RPC_URL_${vault.chainId}`]
    if (!rpcUrl) {
      console.warn(`gap:missing-rpc chainId=${vault.chainId}`)
      return
    }

    let client = rpcClients.get(vault.chainId)
    if (!client) {
      client = createChainClient(vault.chainId, rpcUrl)
      rpcClients.set(vault.chainId, client)
    }

    const blockCacheKey = `${vault.chainId}:${timestamp}`
    let blockNumber = blockNumbers.get(blockCacheKey)
    if (!blockNumber) {
      blockNumber = await estimateBlockByTimestamp(client, vault.chainId, timestamp)
      blockNumbers.set(blockCacheKey, blockNumber)
    }

    try {
      const sharePrice = await readVaultSharePrice(
        client,
        vault.vaultToken,
        vault.decimals,
        vault.apiVersion,
        blockNumber,
      )

      const derivedPrice = underlying.price * sharePrice
      await insertTokenPrices(pool, [{
        chain: vault.chain,
        token: vault.vaultToken,
        timestamp,
        price: derivedPrice,
        symbol: vault.symbol,
        confidence: null,
        source: 'derived',
      }])
      stats.insertedDerived += 1
    } catch (error) {
      stats.failures += 1
      console.error('Derived vault price failed', { vault: vault.vaultToken, timestamp, chainId: vault.chainId }, error)
    }
  })
}

try {
  const { start, end } = parseArgs(process.argv.slice(2))
  const timestamps = buildDailyTimestamps(start, end)
  const vaults = await fetchYearnVaults()

  console.info(`Warmup start: ${timestamps.length} days, ${vaults.length} vaults`)
  await warmDirectPrices(vaults, timestamps, stats)
  await warmDerivedVaultPrices(vaults, timestamps, stats)

  console.info(
    JSON.stringify({
      message: 'warmup-complete',
      range: { start, end },
      timestamps: timestamps.length,
      vaults: vaults.length,
      ...stats,
    }),
  )
} finally {
  await pool.end()
}
