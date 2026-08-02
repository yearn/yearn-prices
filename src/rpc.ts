import { defineChain, createPublicClient, http, parseAbi, type PublicClient } from 'viem'
import { CHAIN_ID_TO_NAME } from './chains'

const SHARE_PRICE_ABI_V2 = parseAbi(['function pricePerShare() view returns (uint256)'])
const SHARE_PRICE_ABI_V3 = parseAbi(['function convertToAssets(uint256) view returns (uint256)'])

const blockCache = new Map<string, bigint>()
const clientCache = new Map<number, PublicClient>()

export type RpcConfigurationFailure = 'missing' | 'mismatch' | 'transport'

export class RpcConfigurationError extends Error {
  constructor(
    readonly expectedChainId: number,
    readonly failure: RpcConfigurationFailure,
    readonly returnedChainId: number | null,
  ) {
    const key = `RPC_URL_${expectedChainId}`
    const message = failure === 'missing'
      ? `${key} is not configured`
      : failure === 'mismatch'
        ? `${key} chain ID mismatch: expected ${expectedChainId}, received ${returnedChainId}`
        : `${key} chain ID validation failed due to a transport or RPC error`
    super(message)
    this.name = 'RpcConfigurationError'
  }
}

export interface RpcChainIdValidationDependencies {
  request?: typeof fetch
}

interface RpcChainIdResponse {
  result?: unknown
  error?: unknown
}

/**
 * Checks a configured endpoint without including the URL or its credentials in
 * any error. This is intentionally separate from asset resolution: an RPC
 * configuration failure must never become unsupported-price evidence.
 */
export async function validateRpcChainId(
  expectedChainId: number,
  rpcUrl: string | undefined,
  dependencies: RpcChainIdValidationDependencies = {},
): Promise<void> {
  if (!rpcUrl) throw new RpcConfigurationError(expectedChainId, 'missing', null)

  try {
    const response = await (dependencies.request ?? fetch)(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    if (!response.ok) throw new Error('RPC request failed')

    const payload = await response.json() as RpcChainIdResponse
    if (payload.error || typeof payload.result !== 'string') throw new Error('Invalid RPC response')
    const returnedChainId = Number.parseInt(payload.result, 16)
    if (!Number.isSafeInteger(returnedChainId) || returnedChainId < 0) {
      throw new Error('Invalid RPC chain ID')
    }
    if (returnedChainId !== expectedChainId) {
      throw new RpcConfigurationError(expectedChainId, 'mismatch', returnedChainId)
    }
  } catch (error) {
    if (error instanceof RpcConfigurationError) throw error
    throw new RpcConfigurationError(expectedChainId, 'transport', null)
  }
}

/** Validates every supported RPC key present in the supplied environment. */
export async function validateConfiguredRpcChainIds(
  env: Record<string, string | undefined> = process.env,
  dependencies: RpcChainIdValidationDependencies = {},
): Promise<void> {
  const configured = Object.keys(CHAIN_ID_TO_NAME)
    .map(Number)
    .filter(chainId => Object.hasOwn(env, `RPC_URL_${chainId}`))
    .sort((left, right) => left - right)

  for (const chainId of configured) {
    await validateRpcChainId(chainId, env[`RPC_URL_${chainId}`], dependencies)
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function compareApiVersions(left: string | null | undefined, right: string): number {
  const leftParts = (left ?? '0.0.0').split('.').map(part => Number(part))
  const rightParts = right.split('.').map(part => Number(part))
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
export function getChainClient(chainId: number): PublicClient | null {
  const cached = clientCache.get(chainId)
  if (cached) {
    return cached
  }

  const rpcUrl = process.env[`RPC_URL_${chainId}`]
  if (!rpcUrl) {
    return null
  }

  const client = createChainClient(chainId, rpcUrl)
  clientCache.set(chainId, client)
  return client
}

export async function estimateBlockByTimestamp(client: PublicClient, chainId: number, timestamp: number): Promise<bigint> {
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
