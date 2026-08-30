import { createPublicClient, defineChain, http, type PublicClient, parseAbi } from 'viem'
import { CHAIN_ID_TO_NAME } from '../utils/chains'

const SHARE_PRICE_ABI_V2 = parseAbi(['function pricePerShare() view returns (uint256)'])
const SHARE_PRICE_ABI_V3 = parseAbi(['function convertToAssets(uint256) view returns (uint256)'])

const MAX_BLOCK_CACHE = 512
const MAX_SAMPLES_PER_CHAIN = 64
const MAX_CLIENT_CACHE = 64

const blockCache = new Map<string, bigint>()
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

function createChainClient(chainId: number, rpcUrl: string): PublicClient {
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
        http: [rpcUrl]
      }
    }
  })

  return createPublicClient({
    chain,
    transport: http(rpcUrl, {
      batch: true,
      retryCount: 2,
      retryDelay: 250
    })
  })
}

function rpcUrlForChain(chainId: number, env?: Record<string, string | undefined>): string | undefined {
  if (env) {
    return env[`RPC_URL_${chainId}`]
  }
  // Workers have no `process` unless nodejs_compat is on. Scripts and tests
  // still read process.env when no Worker env is passed.
  if (typeof process === 'undefined') {
    return undefined
  }
  return process.env[`RPC_URL_${chainId}`]
}

/**
 * Returns a memoized client for `chainId`, or null when no `RPC_URL_<chainId>`
 * is configured. Callers decide how to surface the missing-RPC gap.
 */
export function getChainClient(chainId: number, env?: Record<string, string | undefined>): PublicClient | null {
  const rpcUrl = rpcUrlForChain(chainId, env)
  if (!rpcUrl) {
    return null
  }

  // Keyed by URL as well as chain: one isolate serves many envs, and keying by
  // chain alone hands the first caller's RPC to every later one.
  const cacheKey = `${chainId}:${rpcUrl}`
  const cached = clientCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const client = createChainClient(chainId, rpcUrl)
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

  const latestBlock = await client.getBlock()
  const latestTimestamp = Number(latestBlock.timestamp)
  rememberSample(chainId, latestBlock.number, latestTimestamp)
  if (latestTimestamp <= timestamp) {
    return latestBlock.number
  }

  const bounds = seedBounds(chainId, timestamp, latestBlock.number, latestTimestamp)
  let probes = 0

  while (bounds.low <= bounds.high) {
    const mid = nextProbe(bounds, timestamp, probes)
    probes += 1
    const block = await client.getBlock({ blockNumber: mid })
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
