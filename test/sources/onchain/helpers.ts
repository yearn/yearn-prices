import type { PublicClient } from 'viem'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import type { OnchainAdapterOptions } from '../../../src/sources/onchain/context'
import type { MarketPriceResolver, RecursivePriceAdapter, ResolvedPricePath } from '../../../src/sources/onchain/types'

export const BLOCK_NUMBER = 19_000_000n
export const BLOCK_TIMESTAMP = 1_700_000_000

export type ContractReads = Record<string, Record<string, unknown>>

class ContractRevert extends Error {
  constructor(address: string, functionName: string) {
    super(`execution reverted: ${address}.${functionName}`)
    this.name = 'ContractFunctionExecutionError'
  }
}

/**
 * Fake client keyed by lowercase address then function name. A missing entry
 * reverts, which is how an adapter learns a contract lacks an interface.
 */
export function fakeClient(reads: ContractReads): PublicClient {
  return {
    async getBlockNumber() {
      return BLOCK_NUMBER
    },
    async getBlock() {
      return { number: BLOCK_NUMBER, timestamp: BigInt(BLOCK_TIMESTAMP) }
    },
    async readContract({ address, functionName }: { address: string; functionName: string }) {
      const contract = reads[address.toLowerCase()]
      if (!contract || !(functionName in contract)) {
        throw new ContractRevert(address, functionName)
      }
      const value = contract[functionName]
      if (value instanceof Error) {
        throw value
      }
      return value
    }
  } as unknown as PublicClient
}

export function adapterOptions(reads: ContractReads): OnchainAdapterOptions {
  return { clientForChain: () => fakeClient(reads) }
}

export function marketFor(prices: Record<string, number>): MarketPriceResolver {
  return async (target) => {
    const priceUsd = prices[target.token.toLowerCase()]
    if (priceUsd === undefined) {
      return null
    }
    const path: ResolvedPricePath = {
      chainId: target.chainId,
      token: target.token,
      requestedTimestamp: target.timestamp,
      observedTimestamp: BLOCK_TIMESTAMP,
      priceUsd,
      symbol: null,
      confidence: null,
      source: 'enso',
      adapter: 'enso',
      blockNumber: target.blockNumber ?? null,
      inputs: [],
      metadata: {}
    }
    return path
  }
}

export function priceWith(adapter: RecursivePriceAdapter, prices: Record<string, number>, token: string, chainId = 1) {
  return new RecursivePriceEngine(marketFor(prices), [adapter]).resolve({
    chainId,
    token,
    timestamp: null
  })
}
