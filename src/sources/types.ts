// Plug-in contract for spot and historical price sources. Adding a source = one file
// implementing SpotPriceSource / HistoricalPriceSource + registering it in src/registries/.

export interface SpotPrice {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
  source: string
}

export interface SpotPriceResult {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
}

export interface SpotPriceSource {
  /** Stable id; stamped on every price this source returns. */
  name: string
  /** Lower = tried first. Ties keep registration order. */
  priority: number
  supports(chainId: number): boolean
  /**
   * Returns the live price, or null when this source has no price for the
   * token (the resolver then falls through to the next source). Throws
   * ApiError for failures: NOT_FOUND is treated like null; anything else
   * is surfaced as retryable if no other source succeeds.
   * The registry guarantees `source` is stamped.
   */
  getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null>
}

export interface HistoricalPrice {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
  source: string
}

export interface HistoricalPriceResult {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
}

export interface HistoricalPriceTarget {
  chainId: number
  token: string
  timestamp: number
}

export interface HistoricalBatchPrice {
  target: HistoricalPriceTarget
  price: HistoricalPriceResult
}

export interface HistoricalPriceSource {
  /** Stable id; stamped on every price this source returns. */
  name: string
  /** Lower = tried first. Ties keep registration order. */
  priority: number
  supports(chainId: number): boolean
  /**
   * Returns the historical price, or null when this source has no price for
   * the token at the requested timestamp. Throws ApiError for failures:
   * NOT_FOUND is treated like null; anything else is surfaced as retryable
   * if no other source succeeds.
   * The registry guarantees `source` is stamped.
   */
  getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null>
  /** Optional provider-native batch path. The registry falls back per unresolved target. */
  getBatchHistoricalPrices?(
    targets: HistoricalPriceTarget[],
    onResolved?: (entry: HistoricalBatchPrice) => void
  ): Promise<HistoricalBatchPrice[]>
}
