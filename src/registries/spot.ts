import { ApiError } from '../http/errors'
import { createEnsoSpotSource } from '../sources'
import { createOnchainSpotSource } from '../sources/onchain'
import type { MarketPriceResolver } from '../sources/onchain'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env, PriceSource } from '../types'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: SpotPriceSource[]): MarketPriceResolver {
  const registry = new SpotSourceRegistry(marketSources)

  return async (target) => {
    if (!marketSources.some((source) => source.supports(target.chainId))) {
      return null
    }

    try {
      const price = await registry.resolve(target.chainId, target.token)
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

export function createSpotSources(env: Env): SpotPriceSource[] {
  if (!env.ENSO_API_KEY) {
    throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  }

  const marketSources = [createEnsoSpotSource(env.ENSO_API_KEY)]

  return [
    ...marketSources,
    createOnchainSpotSource({ marketPrice: marketPriceResolver(marketSources) }),
  ]
}

export class SpotSourceRegistry {
  private readonly sources: SpotPriceSource[]

  constructor(sources: SpotPriceSource[]) {
    const names = new Set<string>()
    for (const source of sources) {
      if (names.has(source.name)) {
        throw new Error(`Duplicate spot price source name: ${source.name}`)
      }
      names.add(source.name)
    }
    // Stable sort: equal priorities keep registration order.
    this.sources = [...sources].sort((a, b) => a.priority - b.priority)
  }

  all(): readonly SpotPriceSource[] {
    return this.sources
  }

  /**
   * Tries sources in priority order; first price wins. NOT_FOUND and null
   * fall through to the next source. Any other error is remembered and
   * rethrown only if no later source produces a price, so a transient
   * failure in one source never masks a working fallback.
   */
  async resolve(chainId: number, token: string): Promise<SpotPrice> {
    let lastError: unknown

    for (const source of this.sources) {
      if (!source.supports(chainId)) {
        continue
      }

      try {
        const price = await source.getSpotPrice(chainId, token)
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

    throw new ApiError('NOT_FOUND', 'No price available for this token')
  }
}

let spotRegistryInstance: SpotSourceRegistry | null = null

export function getSpotSourceRegistry(env?: Env): SpotSourceRegistry {
  if (!spotRegistryInstance) {
    if (!env) {
      throw new Error('Env is required to initialize SpotSourceRegistry')
    }
    spotRegistryInstance = new SpotSourceRegistry(createSpotSources(env))
  }
  return spotRegistryInstance
}

export function resetSpotSourceRegistry(): void {
  spotRegistryInstance = null
}
