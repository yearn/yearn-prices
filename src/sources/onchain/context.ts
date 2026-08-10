import { parseAbi, type Address, type PublicClient } from 'viem'
import { estimateBlockByTimestamp } from '../../clients/rpc'
import { normalizeTokenAddress } from '../../utils/chains'
import { InvalidPricingError, RetryablePricingError, isRetryablePricingError } from './errors'
import type {
  RecursivePriceContext,
  RecursivePriceInput,
  RecursivePriceTarget,
  ResolvedPricePath,
} from './types'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])

export type ClientForChain = (chainId: number) => PublicClient | null
export type BlockForTarget = (
  client: PublicClient,
  chainId: number,
  target: RecursivePriceTarget,
) => Promise<bigint>
export type BlockTimestampForTarget = (
  client: PublicClient,
  blockNumber: bigint,
  target: RecursivePriceTarget,
) => Promise<number>

export interface OnchainAdapterOptions {
  clientForChain: ClientForChain
  blockForTarget?: BlockForTarget
  blockTimestampForTarget?: BlockTimestampForTarget
  pendleTwapSeconds?: number
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
export async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isRetryablePricingError(error)) {
      throw new RetryablePricingError(error instanceof Error ? error.message : String(error), {
        cause: error,
      })
    }
    return null
  }
}

export function normalizedAddress(address: string): `0x${string}` | null {
  if (address.toLowerCase() === ZERO_ADDRESS) {
    return null
  }
  return normalizeTokenAddress(address)
}

async function defaultBlockForTarget(
  client: PublicClient,
  chainId: number,
  target: RecursivePriceTarget,
): Promise<bigint> {
  if (target.blockNumber != null) {
    return BigInt(target.blockNumber)
  }
  if (target.timestamp == null) {
    return client.getBlockNumber()
  }
  return estimateBlockByTimestamp(client, chainId, target.timestamp)
}

export async function contractContext(
  target: RecursivePriceTarget,
  options: OnchainAdapterOptions,
): Promise<ContractContext> {
  const client = options.clientForChain(target.chainId)
  if (!client) {
    throw new RetryablePricingError(
      `RPC_URL_${target.chainId} is not configured; on-chain pricing is temporarily unavailable`,
    )
  }
  const blockNumber = await (options.blockForTarget ?? defaultBlockForTarget)(
    client,
    target.chainId,
    target,
  )
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
    address: target.token as Address,
  }
}

export function blockEvidence(
  state: ContractContext,
  target: RecursivePriceTarget,
): Record<string, unknown> {
  return {
    block: {
      number: state.numericBlockNumber,
      timestamp: state.blockTimestamp,
      requestedTimestamp: target.timestamp,
      distanceSeconds: target.timestamp == null ? null : target.timestamp - state.blockTimestamp,
    },
  }
}

export function childTarget(
  parent: RecursivePriceTarget,
  token: string,
  blockNumber: number,
): RecursivePriceTarget {
  return { ...parent, token: normalizeTokenAddress(token), blockNumber }
}

export function rawState(value: bigint): string {
  return value.toString()
}

export async function tokenDecimals(
  client: PublicClient,
  address: string,
  blockNumber: bigint,
): Promise<number> {
  return Number(
    await client.readContract({
      address: address as Address,
      abi: erc20Abi,
      functionName: 'decimals',
      blockNumber,
    }),
  )
}

export function recursiveInput(
  path: ResolvedPricePath,
  conversion: Record<string, unknown>,
): RecursivePriceInput {
  return { path, conversion }
}

/** Prices every constituent of a basket, failing the basket if any is missing. */
export async function requireChildren(
  context: RecursivePriceContext,
  parent: RecursivePriceTarget,
  addresses: string[],
  blockNumber: number,
  label: string,
): Promise<ResolvedPricePath[]> {
  return Promise.all(
    addresses.map((address) => context.require(childTarget(parent, address, blockNumber), label)),
  )
}
