import { getChainClient } from '../../clients/rpc'
import { chainIdToName } from '../../utils/chains'
import type {
  HistoricalPriceResult,
  HistoricalPriceSource,
  SpotPriceResult,
  SpotPriceSource,
} from '../types'
import { createOnchainPriceAdapters } from './adapters'
import type { OnchainAdapterOptions } from './context'
import { RecursivePriceEngine } from './engine'
import { RetryablePricingError } from './errors'
import type { MarketPriceResolver, RecursivePriceResult, RecursivePriceTarget } from './types'

export const ONCHAIN_SOURCE_NAME = 'derived'

export interface OnchainSourceOptions extends Partial<OnchainAdapterOptions> {
  /** Prices the tokens an adapter converts into. Injected by the registry. */
  marketPrice: MarketPriceResolver
  priority?: number
  maxDepth?: number
}

function toResult(result: RecursivePriceResult): SpotPriceResult | null {
  if (!result.path) {
    if (result.failure.reason === 'retryable') {
      throw new RetryablePricingError(
        `On-chain pricing failed transiently for ${result.failure.token}: ${JSON.stringify(result.failure.attempts)}`,
      )
    }
    return null
  }
  return {
    price: result.path.priceUsd,
    timestamp: result.path.observedTimestamp,
    symbol: result.path.symbol,
    confidence: result.path.confidence,
  }
}

function resolver(options: OnchainSourceOptions) {
  const adapterOptions: OnchainAdapterOptions = {
    clientForChain: options.clientForChain ?? getChainClient,
    blockForTarget: options.blockForTarget,
    blockTimestampForTarget: options.blockTimestampForTarget,
    pendleTwapSeconds: options.pendleTwapSeconds,
  }
  const adapters = createOnchainPriceAdapters(adapterOptions)
  // Shared across requests: which adapter last priced a token. Prices are not
  // shared — a fresh engine per request keeps its own resolution cache.
  const adapterHints = new Map<string, string>()

  return (target: RecursivePriceTarget) =>
    new RecursivePriceEngine(
      options.marketPrice,
      adapters,
      options.maxDepth ?? 8,
      adapterHints,
    ).resolve(target)
}

export function createOnchainSpotSource(options: OnchainSourceOptions): SpotPriceSource {
  const resolve = resolver(options)

  return {
    name: ONCHAIN_SOURCE_NAME,
    priority: options.priority ?? 20,
    supports: (chainId: number) => chainIdToName(chainId) !== undefined,
    async getSpotPrice(chainId: number, token: string) {
      return toResult(await resolve({ chainId, token, timestamp: null }))
    },
  }
}

export function createOnchainHistoricalSource(
  options: OnchainSourceOptions,
): HistoricalPriceSource {
  const resolve = resolver(options)

  return {
    name: ONCHAIN_SOURCE_NAME,
    priority: options.priority ?? 20,
    supports: (chainId: number) => chainIdToName(chainId) !== undefined,
    async getHistoricalPrice(
      chainId: number,
      token: string,
      timestamp: number,
    ): Promise<HistoricalPriceResult | null> {
      return toResult(await resolve({ chainId, token, timestamp }))
    },
  }
}
