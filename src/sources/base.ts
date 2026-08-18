import type { HistoricalPriceResult, HistoricalPriceSource, SpotPriceResult, SpotPriceSource } from './types'

abstract class PriceSourceBase {
  /** Stable id; stamped on every price this source returns. */
  abstract readonly name: string
  /** Lower = tried first. Ties keep registration order. */
  abstract readonly priority: number

  abstract supports(chainId: number): boolean
}

export abstract class SpotPriceSourceBase extends PriceSourceBase implements SpotPriceSource {
  abstract getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null>
}

export abstract class HistoricalPriceSourceBase extends PriceSourceBase implements HistoricalPriceSource {
  abstract getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null>
}
