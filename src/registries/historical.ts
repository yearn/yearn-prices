import { DefiLlamaClient } from '../clients/defillama'
import { ApiError } from '../http/errors'
import { createDefiLlamaHistoricalSource } from '../sources'
import { createOnchainHistoricalSource } from '../sources/onchain'
import type { MarketPriceResolver } from '../sources/onchain'
import type { HistoricalPrice, HistoricalPriceSource } from '../sources/types'

import type { Env, PriceSource } from '../types'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: HistoricalPriceSource[]): MarketPriceResolver {
  const registry = new HistoricalSourceRegistry(marketSources)

  return async (target) => {
    if (target.timestamp == null || !marketSources.some((source) => source.supports(target.chainId))) {
      return null
    }

    try {
      const price = await registry.resolve(target.chainId, target.token, target.timestamp)
      return {
        chainId: target.chainId,
        token: target.token,
        requestedTimestamp: target.timestamp,
        observedTimestamp: price.timestamp,
        priceUsd: price.price,
        symbol: price.symbol,
        confidence: price.confidence,
        source: price.source as PriceSource,
        adapter: price.source,
        blockNumber: target.blockNumber ?? null,
        inputs: [],
        metadata: {},
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        return null
      }
      throw error
    }
  }
}

export function createHistoricalSources(_env?: Env): HistoricalPriceSource[] {
  const marketSources = [createDefiLlamaHistoricalSource(new DefiLlamaClient())]

  return [
    ...marketSources,
    createOnchainHistoricalSource({ marketPrice: marketPriceResolver(marketSources) }),
  ]
}

export class HistoricalSourceRegistry {
  private readonly sources: HistoricalPriceSource[]

  constructor(sources: HistoricalPriceSource[]) {
    const names = new Set<string>()
    for (const source of sources) {
      if (names.has(source.name)) {
        throw new Error(`Duplicate historical price source name: ${source.name}`)
      }
      names.add(source.name)
    }
    // Stable sort: equal priorities keep registration order.
    this.sources = [...sources].sort((a, b) => a.priority - b.priority)
  }

  all(): readonly HistoricalPriceSource[] {
    return this.sources
  }

  /**
   * Tries sources in priority order; first price wins. NOT_FOUND and null
   * fall through to the next source. Any other error is remembered and
   * rethrown only if no later source produces a price, so a transient
   * failure in one source never masks a working fallback.
   */
  async resolve(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPrice> {
    let lastError: unknown

    for (const source of this.sources) {
      if (!source.supports(chainId)) {
        continue
      }

      try {
        const price = await source.getHistoricalPrice(chainId, token, timestamp)
        if (price !== null) {
          return { ...price, source: source.name }
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          continue
        }
        lastError = error
      }
    }

    if (lastError !== undefined) {
      throw lastError
    }

    throw new ApiError('NOT_FOUND', 'No historical price available for this token')
  }
}

let historicalRegistryInstance: HistoricalSourceRegistry | null = null

export function getHistoricalSourceRegistry(env?: Env): HistoricalSourceRegistry {
  if (!historicalRegistryInstance) {
    historicalRegistryInstance = new HistoricalSourceRegistry(createHistoricalSources(env))
  }
  return historicalRegistryInstance
}

export function resetHistoricalSourceRegistry(): void {
  historicalRegistryInstance = null
}
