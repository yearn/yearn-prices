import { ApiError } from '../http/errors'
import type { MarketPriceResolver, ResolvedPricePath } from '../sources/onchain/types'
import type { PriceSource } from '../types'

interface MarketQuote {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
  source: string
}

interface MarketSource {
  supports(chainId: number): boolean
}

/**
 * Turns a market-source registry resolve into the on-chain engine's
 * MarketPriceResolver. Spot and historical share this mapping so neither
 * resolver ever sees the on-chain source.
 */
export function createMarketPriceResolver(
  marketSources: MarketSource[],
  resolve: (chainId: number, token: string, timestamp: number | null) => Promise<MarketQuote>,
  options?: { requireTimestamp?: boolean },
): MarketPriceResolver {
  return async (target) => {
    if (options?.requireTimestamp && target.timestamp == null) {
      return null
    }
    if (!marketSources.some((source) => source.supports(target.chainId))) {
      return null
    }

    try {
      const price = await resolve(target.chainId, target.token, target.timestamp)
      const path: ResolvedPricePath = {
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
      return path
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        return null
      }
      throw error
    }
  }
}
