import { DefiLlamaClient } from '../clients/defillama'
import { ApiError } from '../http/errors'
import { createDefiLlamaHistoricalSource } from '../sources'
import { createOnchainHistoricalSource } from '../sources/onchain'
import type { MarketPriceResolver } from '../sources/onchain'
import type { HistoricalPrice, HistoricalPriceSource } from '../sources/types'
import type { Env, PriceSource } from '../types'

import { SourceRegistry } from './source-registry'

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

export class HistoricalSourceRegistry extends SourceRegistry<
  HistoricalPriceSource,
  [timestamp: number]
> {
  constructor(sources: HistoricalPriceSource[]) {
    super(
      sources,
      'historical',
      (source, chainId, token, timestamp) =>
        source.getHistoricalPrice(chainId, token, timestamp),
      'No historical price available for this token',
    )
  }

  override resolve(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPrice> {
    return super.resolve(chainId, token, timestamp)
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
