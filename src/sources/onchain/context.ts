import { type Address, type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp } from '../../clients/rpc'
import { normalizeTokenAddress } from '../../utils/chains'
import { erc4626Abi } from './abis'
import { InvalidPricingError, isRetryablePricingError, ReadBudgetExceededError, RetryablePricingError } from './errors'
import type { RecursivePriceContext, RecursivePriceInput, RecursivePriceTarget, ResolvedPricePath } from './types'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
])

export type ClientForChain = (chainId: number) => PublicClient | null
export type BlockForTarget = (client: PublicClient, chainId: number, target: RecursivePriceTarget) => Promise<bigint>
export type BlockTimestampForTarget = (
  client: PublicClient,
  blockNumber: bigint,
  target: RecursivePriceTarget
) => Promise<number>

export interface OnchainAdapterOptions {
  clientForChain: ClientForChain
  blockForTarget?: BlockForTarget
  blockTimestampForTarget?: BlockTimestampForTarget
  pendleTwapSeconds?: number
  blockContextCache?: Map<string, Promise<ContractContext>>
}

export interface ContractContext {
  client: PublicClient
  chainId: number
  blockNumber: bigint
  numericBlockNumber: number
  blockTimestamp: number
  address: Address
}

/**
 * Runs a contract read that is allowed to be absent. A revert means "this
 * contract does not implement the call"; a transport failure is rethrown as
 * retryable so it never reads as absence.
 */
function transientReadMessage(error: unknown): string {
  if (error instanceof Error) {
    const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined
    return status === undefined ? error.name : `${error.name} ${status}`
  }
  return 'retryable contract read'
}

export async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    // A spent budget is a resource cutoff, not a missing function: swallowing
    // it here would report an unread token as unpriceable.
    if (error instanceof ReadBudgetExceededError) {
      throw error
    }
    if (isRetryablePricingError(error)) {
      throw new RetryablePricingError(transientReadMessage(error), { cause: error })
    }
    return null
  }
}

export async function readShareConversion(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
  oneShareRaw: bigint
): Promise<{ method: 'convertToAssets' | 'previewRedeem'; convertedAssetsRaw: bigint } | null> {
  let method: 'convertToAssets' | 'previewRedeem' = 'convertToAssets'
  let convertedAssetsRaw = await maybe(() =>
    client.readContract({
      address,
      abi: erc4626Abi,
      functionName: 'convertToAssets',
      args: [oneShareRaw],
      blockNumber
    })
  )
  if (convertedAssetsRaw == null) {
    method = 'previewRedeem'
    convertedAssetsRaw = await maybe(() =>
      client.readContract({
        address,
        abi: erc4626Abi,
        functionName: 'previewRedeem',
        args: [oneShareRaw],
        blockNumber
      })
    )
  }
  if (convertedAssetsRaw == null) {
    return null
  }
  if (convertedAssetsRaw === 0n) {
    throw new InvalidPricingError('Share conversion returned zero assets')
  }
  return { method, convertedAssetsRaw }
}

export function normalizedAddress(address: string): `0x${string}` | null {
  if (address.toLowerCase() === ZERO_ADDRESS) {
    return null
  }
  return normalizeTokenAddress(address)
}

function blockContextKey(target: RecursivePriceTarget): string {
  return [target.chainId, target.token.toLowerCase(), target.timestamp ?? 'latest', target.blockNumber ?? 'none'].join(
    ':'
  )
}

async function defaultBlockForTarget(
  client: PublicClient,
  chainId: number,
  target: RecursivePriceTarget
): Promise<bigint> {
  if (target.blockNumber != null) {
    return BigInt(target.blockNumber)
  }
  if (target.timestamp == null) {
    return client.getBlockNumber()
  }
  return estimateBlockByTimestamp(client, chainId, target.timestamp)
}

async function loadContractContext(
  target: RecursivePriceTarget,
  options: OnchainAdapterOptions
): Promise<ContractContext> {
  const client = options.clientForChain(target.chainId)
  if (!client) {
    // A missing RPC is a deployment gap, not a transient fault: report it as
    // "this adapter does not apply" so it never masks a working source.
    throw new Error(`RPC_URL_${target.chainId} is not configured`)
  }
  const blockNumber = await (options.blockForTarget ?? defaultBlockForTarget)(client, target.chainId, target)
  const numericBlockNumber = Number(blockNumber)
  if (!Number.isSafeInteger(numericBlockNumber) || numericBlockNumber < 0) {
    throw new Error(`Block ${blockNumber} is outside the supported numeric range`)
  }
  const blockTimestamp = options.blockTimestampForTarget
    ? await options.blockTimestampForTarget(client, blockNumber, target)
    : Number((await client.getBlock({ blockNumber })).timestamp)
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) {
    throw new InvalidPricingError('Block has an invalid timestamp')
  }
  if (target.timestamp != null && blockTimestamp > target.timestamp) {
    throw new InvalidPricingError('Block is after the requested timestamp')
  }
  return {
    client,
    chainId: target.chainId,
    blockNumber,
    numericBlockNumber,
    blockTimestamp,
    address: target.token as Address
  }
}

export async function contractContext(
  target: RecursivePriceTarget,
  options: OnchainAdapterOptions
): Promise<ContractContext> {
  const cache = options.blockContextCache
  if (!cache) {
    return loadContractContext(target, options)
  }
  const key = blockContextKey(target)
  const cached = cache.get(key)
  if (cached) {
    return cached
  }
  const pending = loadContractContext(target, options)
  cache.set(key, pending)
  return pending
}

export function blockEvidence(state: ContractContext, target: RecursivePriceTarget): Record<string, unknown> {
  return {
    block: {
      number: state.numericBlockNumber,
      timestamp: state.blockTimestamp,
      requestedTimestamp: target.timestamp,
      distanceSeconds: target.timestamp == null ? null : target.timestamp - state.blockTimestamp
    }
  }
}

export function childTarget(parent: RecursivePriceTarget, token: string, blockNumber: number): RecursivePriceTarget {
  return { ...parent, token: normalizeTokenAddress(token), blockNumber }
}

export function rawState(value: bigint): string {
  return value.toString()
}

export async function tokenDecimals(client: PublicClient, address: string, blockNumber: bigint): Promise<number> {
  return Number(
    await client.readContract({
      address: address as Address,
      abi: erc20Abi,
      functionName: 'decimals',
      blockNumber
    })
  )
}

export function recursiveInput(path: ResolvedPricePath, conversion: Record<string, unknown>): RecursivePriceInput {
  return { path, conversion }
}

/** Prices what it can, leaving a null where a constituent has no price. */
export async function optionalChildren(
  context: RecursivePriceContext,
  parent: RecursivePriceTarget,
  addresses: string[],
  blockNumber: number
): Promise<Array<ResolvedPricePath | null>> {
  const results = await Promise.all(
    addresses.map((address) => context.resolve(childTarget(parent, address, blockNumber)))
  )
  return results.map((result) => result.path ?? null)
}

/** Prices every constituent of a basket, failing the basket if any is missing. */
export async function requireChildren(
  context: RecursivePriceContext,
  parent: RecursivePriceTarget,
  addresses: string[],
  blockNumber: number,
  label: string
): Promise<ResolvedPricePath[]> {
  return Promise.all(addresses.map((address) => context.require(childTarget(parent, address, blockNumber), label)))
}
