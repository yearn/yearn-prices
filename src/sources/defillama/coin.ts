import type { HistoricalPriceResult } from '../types'

interface DefiLlamaCoin {
  price?: unknown
  timestamp?: unknown
  symbol?: string | null
  confidence?: number | null
}

/**
 * Maps one DeFiLlama coin entry to a price, or to null when the provider
 * answered with something that is not a price.
 */
export function toHistoricalPrice(
  coin: DefiLlamaCoin | undefined,
  isUsable: (price: unknown, timestamp: unknown) => boolean
): HistoricalPriceResult | null {
  if (!coin || !isUsable(coin.price, coin.timestamp)) {
    return null
  }

  return {
    price: coin.price as number,
    timestamp: coin.timestamp as number,
    symbol: coin.symbol ?? null,
    confidence: coin.confidence ?? null
  }
}
