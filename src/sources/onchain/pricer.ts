import { getChainClient } from '../../clients/rpc'
import { ApiError } from '../../http/errors'
import { chainIdToName } from '../../utils/chains'
import type { SpotPriceResult } from '../types'
import { createOnchainPriceAdapters } from './adapters'
import type { ClientForChain, OnchainAdapterOptions } from './context'
import { RecursivePriceEngine } from './engine'
import { RecursiveDependencyError } from './errors'
import { DEFAULT_MAX_DEPTH, type OnchainSourceOptions } from './options'
import type {
  MarketPriceResolver,
  PriceResolutionFailure,
  RecursivePriceResult,
  RecursivePriceTarget,
} from './types'

/**
 * Digs out the error that actually failed, so an upstream ApiError reaches the
 * caller as itself instead of a generic on-chain wrapper.
 */
function transientCause(failure: PriceResolutionFailure): unknown {
  for (const attempt of failure.attempts) {
    if (attempt.reason !== 'retryable') {
      continue
    }
    let cause = attempt.cause
    while (cause instanceof RecursiveDependencyError) {
      cause = transientCause(cause.failure)
    }
    if (cause !== undefined) {
      return cause
    }
  }
  return undefined
}

/**
 * The adapter set and chain clients behind both on-chain sources. Spot and
 * historical differ only in the target they ask for, so they share this.
 */
export class OnchainPricer {
  private readonly clientForChain: ClientForChain
  private readonly adapterOptions: OnchainAdapterOptions
  private readonly marketPrice: MarketPriceResolver
  private readonly maxDepth: number
  private readonly resolutionBudget: number | undefined
  // Shared across requests: which adapter last priced a token. Prices are not
  // shared - a fresh engine per request keeps its own resolution cache.
  private readonly adapterHints = new Map<string, string>()

  constructor(options: OnchainSourceOptions) {
    this.clientForChain =
      options.clientForChain ?? ((chainId) => getChainClient(chainId, options.env))
    this.marketPrice = options.marketPrice
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    this.resolutionBudget = options.resolutionBudget
    this.adapterOptions = {
      clientForChain: this.clientForChain,
      blockForTarget: options.blockForTarget,
      blockTimestampForTarget: options.blockTimestampForTarget,
      pendleTwapSeconds: options.pendleTwapSeconds,
    }
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined && this.clientForChain(chainId) !== null
  }

  async price(target: RecursivePriceTarget): Promise<SpotPriceResult | null> {
    const adapters = createOnchainPriceAdapters({
      ...this.adapterOptions,
      blockContextCache: new Map(),
    })
    const engine = new RecursivePriceEngine(
      this.marketPrice,
      adapters,
      this.maxDepth,
      this.adapterHints,
      this.resolutionBudget,
    )
    return this.toResult(await engine.resolve(target))
  }

  private toResult(result: RecursivePriceResult): SpotPriceResult | null {
    if (!result.path) {
      // A spent budget is a resource cutoff, not absence: surfacing it as
      // NOT_FOUND would make an over-broad pool read as an unpriced token.
      if (result.failure.reason === 'budget') {
        throw new ApiError(
          'UNAVAILABLE',
          `On-chain pricing exhausted its resolution budget for ${result.failure.token}`,
        )
      }
      if (result.failure.reason === 'retryable') {
        const cause = transientCause(result.failure)
        if (cause instanceof ApiError) {
          throw cause
        }
        // An ApiError, not a bare Error: the historical route rethrows anything
        // it does not recognise and the worker turns that into a 500.
        throw new ApiError(
          'UNAVAILABLE',
          `On-chain pricing failed transiently for ${result.failure.token}`,
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
}
