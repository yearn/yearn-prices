import { getChainClient } from '../../clients/rpc'
import { chainIdToName } from '../../utils/chains'
import { HistoricalPriceSourceBase, SpotPriceSourceBase } from '../base'
import type { HistoricalPriceResult, SpotPriceResult } from '../types'
import { createOnchainPriceAdapters } from './adapters'
import type { ClientForChain, OnchainAdapterOptions } from './context'
import { RecursivePriceEngine } from './engine'
import { RecursiveDependencyError, RetryablePricingError } from './errors'
import type {
  MarketPriceResolver,
  PriceResolutionFailure,
  RecursivePriceAdapter,
  RecursivePriceResult,
  RecursivePriceTarget,
} from './types'

export const ONCHAIN_SOURCE_NAME = 'derived'

const DEFAULT_PRIORITY = 20
const DEFAULT_MAX_DEPTH = 8

export interface OnchainSourceOptions extends Partial<OnchainAdapterOptions> {
  /** Prices the tokens an adapter converts into. Injected by the registry. */
  marketPrice: MarketPriceResolver
  priority?: number
  maxDepth?: number
}

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
class OnchainPricer {
  private readonly clientForChain: ClientForChain
  private readonly adapters: RecursivePriceAdapter[]
  private readonly marketPrice: MarketPriceResolver
  private readonly maxDepth: number
  // Shared across requests: which adapter last priced a token. Prices are not
  // shared - a fresh engine per request keeps its own resolution cache.
  private readonly adapterHints = new Map<string, string>()

  constructor(options: OnchainSourceOptions) {
    this.clientForChain = options.clientForChain ?? getChainClient
    this.marketPrice = options.marketPrice
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
    this.adapters = createOnchainPriceAdapters({
      clientForChain: this.clientForChain,
      blockForTarget: options.blockForTarget,
      blockTimestampForTarget: options.blockTimestampForTarget,
      pendleTwapSeconds: options.pendleTwapSeconds,
    })
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined && this.clientForChain(chainId) !== null
  }

  async price(target: RecursivePriceTarget): Promise<SpotPriceResult | null> {
    const engine = new RecursivePriceEngine(
      this.marketPrice,
      this.adapters,
      this.maxDepth,
      this.adapterHints,
    )
    return this.toResult(await engine.resolve(target))
  }

  private toResult(result: RecursivePriceResult): SpotPriceResult | null {
    if (!result.path) {
      if (result.failure.reason === 'retryable') {
        throw (
          transientCause(result.failure) ??
          new RetryablePricingError(
            `On-chain pricing failed transiently for ${result.failure.token}`,
          )
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

export class OnchainSpotSource extends SpotPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null> {
    return this.pricer.price({ chainId, token, timestamp: null })
  }
}

export class OnchainHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getHistoricalPrice(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPriceResult | null> {
    return this.pricer.price({ chainId, token, timestamp })
  }
}

export function createOnchainSpotSource(options: OnchainSourceOptions): OnchainSpotSource {
  return new OnchainSpotSource(options)
}

export function createOnchainHistoricalSource(
  options: OnchainSourceOptions,
): OnchainHistoricalSource {
  return new OnchainHistoricalSource(options)
}
