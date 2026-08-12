import { ApiError } from '../http/errors'
import { createEnsoSpotSource } from '../sources'
import { createOnchainSpotSource } from '../sources/onchain'
import type { MarketPriceResolver } from '../sources/onchain'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env, PriceSource } from '../types'

import { SourceRegistry } from './source-registry'

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

export class SpotSourceRegistry extends SourceRegistry<SpotPriceSource> {
  constructor(sources: SpotPriceSource[]) {
    super(
      sources,
      'spot',
      (source, chainId, token) => source.getSpotPrice(chainId, token),
      'No price available for this token',
    )
  }

  override resolve(chainId: number, token: string): Promise<SpotPrice> {
    return super.resolve(chainId, token)
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
