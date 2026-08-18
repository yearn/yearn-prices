import type { PublicClient } from 'viem'
import { getChainClient } from '../../clients/rpc'
import { ApiError } from '../../http/errors'
import { chainIdToName } from '../../utils/chains'
import type { SpotPriceResult } from '../types'
import { createOnchainPriceAdapters } from './adapters'
import type { ClientForChain } from './context'
import { RecursivePriceEngine } from './engine'
import { RecursiveDependencyError } from './errors'
import { DEFAULT_MAX_DEPTH, DEFAULT_READ_BUDGET, type OnchainSourceOptions } from './options'
import { createReadBudget } from './read-budget'
import type { PriceResolutionFailure, RecursivePriceResult, RecursivePriceTarget } from './types'

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

// Shared across requests: which adapter last priced a token. Prices are never
// shared - each pricer owns one engine and its resolution cache.
const adapterHints = new Map<string, string>()

/**
 * The adapter set and chain clients behind both on-chain sources. Spot and
 * historical differ only in the target they ask for, so they share this.
 *
 * One pricer serves one request: its engine, block-context cache and
 * resolution budget are shared by every token in that request and die with it.
 */
export class OnchainPricer {
  private readonly clientForChain: ClientForChain
  private readonly engine: RecursivePriceEngine

  constructor(options: OnchainSourceOptions) {
    const clientForChain = options.clientForChain ?? ((chainId) => getChainClient(chainId, options.env))
    const readBudget = createReadBudget(options.readBudget ?? DEFAULT_READ_BUDGET)
    const metered = new Map<number, PublicClient | null>()
    this.clientForChain = (chainId) => {
      const cached = metered.get(chainId)
      if (cached !== undefined) {
        return cached
      }
      const client = clientForChain(chainId)
      const wrapped = client ? readBudget.meter(client) : null
      metered.set(chainId, wrapped)
      return wrapped
    }
    const adapters = createOnchainPriceAdapters({
      clientForChain: this.clientForChain,
      blockForTarget: options.blockForTarget,
      blockTimestampForTarget: options.blockTimestampForTarget,
      pendleTwapSeconds: options.pendleTwapSeconds,
      blockContextCache: new Map()
    })
    this.engine = new RecursivePriceEngine(
      options.marketPrice,
      adapters,
      options.maxDepth ?? DEFAULT_MAX_DEPTH,
      adapterHints,
      options.resolutionBudget
    )
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined && this.clientForChain(chainId) !== null
  }

  async price(target: RecursivePriceTarget): Promise<SpotPriceResult | null> {
    return this.toResult(await this.engine.resolve(target))
  }

  private toResult(result: RecursivePriceResult): SpotPriceResult | null {
    if (!result.path) {
      // A spent budget is a resource cutoff, not absence: surfacing it as
      // NOT_FOUND would make an over-broad pool read as an unpriced token.
      if (result.failure.reason === 'budget') {
        throw new ApiError(
          'UNAVAILABLE',
          `On-chain pricing exhausted its resolution budget for ${result.failure.token}`
        )
      }
      if (result.failure.reason === 'retryable') {
        const cause = transientCause(result.failure)
        if (cause instanceof ApiError) {
          throw cause
        }
        // An ApiError, not a bare Error: the historical route rethrows anything
        // it does not recognise and the worker turns that into a 500.
        throw new ApiError('UNAVAILABLE', `On-chain pricing failed transiently for ${result.failure.token}`)
      }
      return null
    }
    return {
      price: result.path.priceUsd,
      timestamp: result.path.observedTimestamp,
      symbol: result.path.symbol,
      confidence: result.path.confidence
    }
  }
}
