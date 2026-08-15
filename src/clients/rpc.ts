import { createPublicClient, defineChain, http, parseAbi, type PublicClient } from 'viem'
import { CHAIN_ID_TO_NAME } from '../utils/chains'

const SHARE_PRICE_ABI_V2 = parseAbi(['function pricePerShare() view returns (uint256)'])
const SHARE_PRICE_ABI_V3 = parseAbi(['function convertToAssets(uint256) view returns (uint256)'])

const blockCache = new Map<string, bigint>()
const clientCache = new Map<number, PublicClient>()

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
  })

  return createPublicClient({
    chain,
    transport: http(rpcUrl, {
      batch: true,
      retryCount: 2,
      retryDelay: 250,
    }),
  })
}

/**
 * Returns a memoized client for `chainId`, or null when no `RPC_URL_<chainId>`
 * is configured. Callers decide how to surface the missing-RPC gap.
 */
function rpcUrlForChain(
  chainId: number,
  env?: Record<string, string | undefined>,
): string | undefined {
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

export function getChainClient(
  chainId: number,
  env?: Record<string, string | undefined>,
): PublicClient | null {
  const cached = clientCache.get(chainId)
  if (cached) {
    return cached
  }

  const rpcUrl = rpcUrlForChain(chainId, env)
  if (!rpcUrl) {
    return null
  }

  const client = createChainClient(chainId, rpcUrl)
  clientCache.set(chainId, client)
  return client
}

export async function estimateBlockByTimestamp(
  client: PublicClient,
  chainId: number,
  timestamp: number,
): Promise<bigint> {
  const cacheKey = `${chainId}:${timestamp}`
  const cached = blockCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const latestBlock = await client.getBlock()
  if (Number(latestBlock.timestamp) <= timestamp) {
    blockCache.set(cacheKey, latestBlock.number)
    return latestBlock.number
  }

  let low = 0n
  let high = latestBlock.number
  let best = latestBlock.number

  while (low <= high) {
    const mid = (low + high) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    const blockTimestamp = Number(block.timestamp)

    if (blockTimestamp === timestamp) {
      blockCache.set(cacheKey, mid)
      return mid
    }

    if (blockTimestamp < timestamp) {
      best = mid
      low = mid + 1n
    } else {
      if (mid === 0n) {
        break
      }
      high = mid - 1n
    }

    await sleep(10)
  }

  blockCache.set(cacheKey, best)
  return best
}

export async function readVaultSharePrice(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  decimals: number,
  apiVersion: string | null | undefined,
  blockNumber: bigint,
): Promise<number> {
  const scale = 10n ** BigInt(decimals)

  if (isV3Vault(apiVersion)) {
    const raw = await client.readContract({
      address: vaultAddress,
      abi: SHARE_PRICE_ABI_V3,
      functionName: 'convertToAssets',
      args: [scale],
      blockNumber,
    })
    return Number(raw) / Number(scale)
  }

  const raw = await client.readContract({
    address: vaultAddress,
    abi: SHARE_PRICE_ABI_V2,
    functionName: 'pricePerShare',
    blockNumber,
  })
  return Number(raw) / Number(scale)
}
