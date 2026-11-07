import { BlockNotFoundError, createPublicClient, defineChain, fallback, http, type PublicClient, parseAbi } from 'viem'
import { CHAIN_ID_TO_NAME } from '../utils/chains'
import { MAX_PROVIDER_COOLDOWN_MS, parseRetryAfter } from './http-client'

const SHARE_PRICE_ABI_V2 = parseAbi(['function pricePerShare() view returns (uint256)'])
const SHARE_PRICE_ABI_V3 = parseAbi(['function convertToAssets(uint256) view returns (uint256)'])

const MAX_BLOCK_CACHE = 512
const MAX_SAMPLES_PER_CHAIN = 64
const MAX_CLIENT_CACHE = 64
const MAX_RPC_ENDPOINTS = 16
const RPC_REQUEST_TIMEOUT_MS = 8_000
const RPC_MAX_COOLDOWN_MS = MAX_PROVIDER_COOLDOWN_MS
const RPC_RATE_LIMIT_COOLDOWN_MS = 60_000
const RPC_SERVER_FAILURE_COOLDOWN_MS = 30_000
const RPC_NETWORK_FAILURE_COOLDOWN_MS = 5_000

const blockCache = new Map<string, bigint>()
const blockSearchInflight = new WeakMap<PublicClient, Map<string, Promise<bigint>>>()
const blockSamples = new Map<number, Array<{ number: bigint; timestamp: number }>>()
const clientCache = new Map<string, PublicClient>()

function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  if (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) {
      map.delete(oldest)
    }
  }
}

function rememberSample(chainId: number, number: bigint, timestamp: number): void {
  const samples = blockSamples.get(chainId) ?? []
  samples.push({ number, timestamp })
  if (samples.length > MAX_SAMPLES_PER_CHAIN) {
    samples.shift()
  }
  blockSamples.set(chainId, samples)
}

interface SearchBounds {
  low: bigint
  high: bigint
  best: bigint
  lowTimestamp: number
  highTimestamp: number
}

function seedBounds(chainId: number, timestamp: number, latest: bigint, latestTimestamp: number): SearchBounds {
  let low = 0n
  let lowTimestamp = 0
  let high = latest
  let highTimestamp = latestTimestamp
  // Genesis, not latest: a timestamp older than the whole chain must not fall
  // back to the head block.
  let best = 0n
  for (const sample of blockSamples.get(chainId) ?? []) {
    if (sample.timestamp === timestamp) {
      return {
        low: sample.number,
        high: sample.number,
        best: sample.number,
        lowTimestamp: timestamp,
        highTimestamp: timestamp
      }
    }
    if (sample.timestamp < timestamp && sample.number > low) {
      low = sample.number
      lowTimestamp = sample.timestamp
      best = sample.number
    }
    if (sample.timestamp > timestamp && sample.number < high) {
      high = sample.number
      highTimestamp = sample.timestamp
    }
  }
  return { low, high, best, lowTimestamp, highTimestamp }
}

// Block times are near-constant per chain, so interpolating between the known
// bound timestamps lands within a few blocks of the target — typically 2-4
// probes instead of ~14 midpoint probes, which was pushing the Worker past its
// time budget (504s). Falls back to midpoints after a few probes so a skewed
// block-time history still converges in O(log n).
const MAX_INTERPOLATION_PROBES = 8

function nextProbe(bounds: SearchBounds, timestamp: number, probes: number): bigint {
  const { low, high, lowTimestamp, highTimestamp } = bounds
  // lowTimestamp === 0 means the low bound is still the unprobed genesis seed:
  // interpolating against unix epoch skews every guess toward the head, so
  // bisect until a real low bound exists.
  if (probes >= MAX_INTERPOLATION_PROBES || lowTimestamp <= 0 || highTimestamp <= lowTimestamp) {
    return (low + high) / 2n
  }
  const fraction = (timestamp - lowTimestamp) / (highTimestamp - lowTimestamp)
  const guess = low + BigInt(Math.round(Number(high - low) * fraction))
  if (guess < low) return low
  if (guess > high) return high
  return guess
}

export function compareApiVersions(left: string | null | undefined, right: string): number {
  const leftParts = (left ?? '0.0.0').split('.').map((part) => Number(part))
  const rightParts = right.split('.').map((part) => Number(part))
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0
    const rightValue = rightParts[index] ?? 0
    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }

  return 0
}

export function isV3Vault(apiVersion: string | null | undefined): boolean {
  return compareApiVersions(apiVersion, '3.0.0') >= 0
}

interface EndpointCooldownState {
  cooldownUntil: number
}

class RpcEndpointCoolingError extends Error {
  constructor() {
    // Do not include the endpoint URL: RPC URLs commonly carry API keys.
    super('RPC endpoint is cooling down')
    this.name = 'RpcEndpointCoolingError'
  }
}

function responseStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && Number.isInteger(status)) return status
  const cause = (error as { cause?: unknown } | null)?.cause
  return cause && cause !== error ? responseStatus(cause) : undefined
}

function responseHeaders(error: unknown): Headers | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers
  if (headers instanceof Headers) return headers
  const cause = (error as { cause?: unknown } | null)?.cause
  return cause && cause !== error ? responseHeaders(cause) : undefined
}

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  const cause = (error as { cause?: unknown } | null)?.cause
  const causeMessage = cause && cause !== error ? errorMessage(cause) : ''
  return `${typeof message === 'string' ? message : ''} ${causeMessage}`
}

function isRateLimitError(error: unknown): boolean {
  return /rate[ -]?limit|too many requests|throttl|quota/i.test(errorMessage(error))
}

function isRpcApplicationError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return (
    name === 'RpcRequestError' ||
    (responseStatus(error) === undefined && typeof (error as { code?: unknown } | null)?.code === 'number')
  )
}

function isTransientRpcStatus(status: number | undefined): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Computes the endpoint quarantine duration for a response status. Provider
 * Retry-After is retained up to the one-hour operational ceiling. Cooling endpoints fail fast rather than
 * sleeping, so even a distant date cannot keep a request pending indefinitely.
 * Absent headers use short defaults to avoid retrying a bad node on every read.
 */
export function rpcCooldownDelay(status: number, retryAfter: string | null = null, now = Date.now()): number {
  if (!isTransientRpcStatus(status)) return 0
  const fallbackDelay = status === 429 ? RPC_RATE_LIMIT_COOLDOWN_MS : RPC_SERVER_FAILURE_COOLDOWN_MS
  return parseRetryAfter(retryAfter, RPC_MAX_COOLDOWN_MS, now) ?? fallbackDelay
}

function extendEndpointCooldown(state: EndpointCooldownState, delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + Math.min(delayMs, RPC_MAX_COOLDOWN_MS))
}

function ensureEndpointAvailable(state: EndpointCooldownState): void {
  if (state.cooldownUntil > Date.now()) throw new RpcEndpointCoolingError()
}

function causedByCooling(error: unknown): boolean {
  if (error instanceof RpcEndpointCoolingError) return true
  const cause = (error as { cause?: unknown } | null)?.cause
  return cause !== undefined && cause !== error ? causedByCooling(cause) : false
}

function createCooldownTransport(url: string, state: EndpointCooldownState): ReturnType<typeof http> {
  const base = http(url, {
    batch: true,
    retryCount: 0,
    retryDelay: 0,
    timeout: RPC_REQUEST_TIMEOUT_MS,
    onFetchRequest: () => {
      // The callback runs immediately before fetch, including for a batch that
      // was queued before another request quarantined this endpoint.
      ensureEndpointAvailable(state)
    },
    onFetchResponse: (response) => {
      const status = response.status
      if (isTransientRpcStatus(status)) {
        extendEndpointCooldown(state, rpcCooldownDelay(status, response.headers.get('retry-after')))
      }
    }
  })

  // http() reports HTTP failures as errors after onFetchResponse and reports
  // transport/timeouts without a Response. Wrap its request once more so both
  // cases quarantine the endpoint, while JSON-RPC application errors (notably
  // execution reverts) remain visible to viem's terminal-error policy.
  return ((parameters) => {
    const transport = base(parameters)
    return {
      ...transport,
      async request(...args: Parameters<typeof transport.request>) {
        ensureEndpointAvailable(state)
        try {
          return await transport.request(...args)
        } catch (error) {
          if (causedByCooling(error)) throw error

          const status = responseStatus(error)
          if (status !== undefined && isTransientRpcStatus(status)) {
            extendEndpointCooldown(state, rpcCooldownDelay(status, responseHeaders(error)?.get('retry-after') ?? null))
          } else if (isRpcApplicationError(error)) {
            // Some providers return quota errors as HTTP 200 JSON-RPC errors.
            if (isRateLimitError(error)) extendEndpointCooldown(state, RPC_RATE_LIMIT_COOLDOWN_MS)
          } else {
            // A timeout/DNS/socket failure has no response headers. Keep its
            // quarantine short so archive recovery does not require a restart.
            extendEndpointCooldown(state, RPC_NETWORK_FAILURE_COOLDOWN_MS)
          }
          throw error
        }
      }
    }
  }) as ReturnType<typeof http>
}

function createChainClient(chainId: number, rpcUrls: string[]): PublicClient {
  const chainName = CHAIN_ID_TO_NAME[chainId as keyof typeof CHAIN_ID_TO_NAME]
  if (!chainName) {
    throw new Error(`Unsupported chain id: ${chainId}`)
  }

  const chain = defineChain({
    id: chainId,
    name: chainName,
    nativeCurrency: {
      name: chainName,
      symbol: chainName.slice(0, 4).toUpperCase(),
      decimals: 18
    },
    rpcUrls: {
      default: {
        http: rpcUrls
      }
    }
  })

  return createPublicClient({
    chain,
    // Keep the configured order stable. A primary archive provider should be
    // preferred until it fails, then viem walks the remaining endpoints. The
    // explicit zero retry counts are deliberate: retrying a dead endpoint
    // before trying the next one multiplies latency and makes rate limits
    // worse. viem's fallback transport keeps execution-revert and rejected
    // transaction errors terminal, so a valid on-chain "revert" is never
    // replaced with a different provider's arbitrary answer.
    transport: fallback(
      rpcUrls.map((rpcUrl) => createCooldownTransport(rpcUrl, { cooldownUntil: 0 })),
      {
        rank: false,
        retryCount: 0,
        retryDelay: 0
      }
    )
  })
}

function envValue(name: string, env?: Record<string, string | undefined>): string | undefined {
  if (env) return env[name]
  // Workers have no `process` unless nodejs_compat is on. Scripts and tests
  // still read process.env when no Worker env is passed.
  if (typeof process === 'undefined') return undefined
  return process.env[name]
}

function canonicalRpcUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('RPC endpoint cannot be empty')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('RPC endpoint must be a valid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RPC endpoint must use http:// or https://')
  }
  if (!parsed.hostname) throw new Error('RPC endpoint must include a hostname')

  // Fragments are not sent over HTTP and would make equivalent endpoints look
  // different. Normalize only that transport-irrelevant part; preserve paths,
  // query strings and credentials because providers commonly encode API keys
  // in those fields.
  parsed.hash = ''
  return parsed.toString()
}

function parseRpcUrlList(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('RPC_URLS_<chainId> must be valid JSON when it starts with [')
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('RPC_URLS_<chainId> JSON must be an array of URL strings')
    }
    return parsed
  }

  // A comma/newline-delimited value is convenient for .env files. Whitespace
  // around each item is ignored, but URLs themselves are never split on spaces
  // or other punctuation that could occur in query strings.
  return trimmed.split(/[\r\n,]+/)
}

/**
 * Resolves the ordered archive RPC set for a chain.
 *
 * `RPC_URL_<chainId>` remains the primary endpoint. `RPC_URLS_<chainId>` may
 * contain a JSON array or comma/newline-delimited backups. Invalid endpoints
 * fail fast so a typo cannot silently turn a historical read into a partial
 * result. The returned URLs are canonicalized and deduplicated.
 */
export function rpcUrlsForChain(chainId: number, env?: Record<string, string | undefined>): string[] {
  const values = [
    envValue(`RPC_URL_${chainId}`, env),
    ...(envValue(`RPC_URLS_${chainId}`, env) ? parseRpcUrlList(envValue(`RPC_URLS_${chainId}`, env) as string) : [])
  ].filter((value): value is string => value !== undefined && value.trim().length > 0)

  const deduplicated: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const canonical = canonicalRpcUrl(value)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    deduplicated.push(canonical)
    if (deduplicated.length > MAX_RPC_ENDPOINTS) {
      throw new Error(`At most ${MAX_RPC_ENDPOINTS} RPC endpoints may be configured for chain ${chainId}`)
    }
  }
  return deduplicated
}

/**
 * Returns a memoized client for `chainId`, or null when neither RPC setting
 * is configured or the configuration is invalid. Callers decide how to surface the missing-RPC gap.
 */
export function getChainClient(chainId: number, env?: Record<string, string | undefined>): PublicClient | null {
  let rpcUrls: string[]
  try {
    rpcUrls = rpcUrlsForChain(chainId, env)
  } catch {
    // Invalid operator configuration disables RPC-backed sources only. Keep
    // the strict parser available to diagnostics without breaking market feeds.
    return null
  }
  if (rpcUrls.length === 0) return null

  // Keyed by the complete ordered URL set as well as chain: one isolate serves
  // many envs, and keying by chain alone hands the first caller's RPCs to every
  // later one. The URL strings are retained only in this bounded in-memory
  // cache; they are never logged or included in error messages.
  const cacheKey = `${chainId}:${rpcUrls.join('|')}`
  const cached = clientCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const client = createChainClient(chainId, rpcUrls)
  setCapped(clientCache, cacheKey, client, MAX_CLIENT_CACHE)
  return client
}

export async function estimateBlockByTimestamp(
  client: PublicClient,
  chainId: number,
  timestamp: number
): Promise<bigint> {
  const cacheKey = `${chainId}:${timestamp}`
  const cached = blockCache.get(cacheKey)
  if (cached !== undefined) {
    setCapped(blockCache, cacheKey, cached, MAX_BLOCK_CACHE)
    return cached
  }

  let inflightForClient = blockSearchInflight.get(client)
  if (!inflightForClient) {
    inflightForClient = new Map()
    blockSearchInflight.set(client, inflightForClient)
  }

  const inflight = inflightForClient.get(cacheKey)
  if (inflight) {
    return inflight
  }

  const search = searchBlockByTimestamp(client, chainId, timestamp, cacheKey)
  inflightForClient.set(cacheKey, search)
  try {
    return await search
  } finally {
    if (inflightForClient.get(cacheKey) === search) {
      inflightForClient.delete(cacheKey)
    }
  }
}

async function searchBlockByTimestamp(
  client: PublicClient,
  chainId: number,
  timestamp: number,
  cacheKey: string
): Promise<bigint> {
  const latestBlock = await client.getBlock()
  const latestTimestamp = Number(latestBlock.timestamp)
  rememberSample(chainId, latestBlock.number, latestTimestamp)
  if (latestTimestamp <= timestamp) {
    return latestBlock.number
  }

  const bounds = seedBounds(chainId, timestamp, latestBlock.number, latestTimestamp)
  let probes = 0
  let missing: BlockNotFoundError | undefined

  while (bounds.low <= bounds.high) {
    const mid = nextProbe(bounds, timestamp, probes)
    probes += 1
    let block: Awaited<ReturnType<PublicClient['getBlock']>>
    try {
      block = await client.getBlock({ blockNumber: mid })
    } catch (error) {
      if (!(error instanceof BlockNotFoundError)) throw error
      // Pruned or pre-migration history (Optimism pre-Bedrock): skip above it.
      missing = error
      bounds.low = mid + 1n
      continue
    }
    const blockTimestamp = Number(block.timestamp)
    rememberSample(chainId, mid, blockTimestamp)

    if (blockTimestamp === timestamp) {
      setCapped(blockCache, cacheKey, mid, MAX_BLOCK_CACHE)
      return mid
    }

    if (blockTimestamp < timestamp) {
      bounds.best = mid
      bounds.low = mid + 1n
      bounds.lowTimestamp = blockTimestamp
    } else {
      if (mid === 0n) {
        break
      }
      bounds.high = mid - 1n
      bounds.highTimestamp = blockTimestamp
    }
  }

  if (missing && bounds.lowTimestamp === 0) {
    throw missing
  }
  setCapped(blockCache, cacheKey, bounds.best, MAX_BLOCK_CACHE)
  return bounds.best
}

export async function readVaultSharePrice(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  decimals: number,
  apiVersion: string | null | undefined,
  blockNumber: bigint
): Promise<number> {
  const scale = 10n ** BigInt(decimals)

  if (isV3Vault(apiVersion)) {
    const raw = await client.readContract({
      address: vaultAddress,
      abi: SHARE_PRICE_ABI_V3,
      functionName: 'convertToAssets',
      args: [scale],
      blockNumber
    })
    return Number(raw) / Number(scale)
  }

  const raw = await client.readContract({
    address: vaultAddress,
    abi: SHARE_PRICE_ABI_V2,
    functionName: 'pricePerShare',
    blockNumber
  })
  return Number(raw) / Number(scale)
}
