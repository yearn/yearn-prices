import type {
  HistoricalPriceResult,
  HistoricalPriceSource,
  SpotPriceResult,
  SpotPriceSource,
} from './types'

abstract class PriceSourceBase {
  /** Stable id; stamped on every price this source returns. */
  abstract readonly name: string
  /** Lower = tried first. Ties keep registration order. */
  abstract readonly priority: number

  abstract supports(chainId: number): boolean

  /**
   * A price is usable only when it is a finite positive number observed at a
   * real time. Every source has to make this judgement, and a source that
   * skips it turns a provider's zero or null into a real-looking answer.
   */
  protected isUsablePrice(price: unknown, timestamp: unknown): boolean {
    return (
      typeof price === 'number' &&
      Number.isFinite(price) &&
      price > 0 &&
      typeof timestamp === 'number' &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0
    )
  }
}

export abstract class SpotPriceSourceBase extends PriceSourceBase implements SpotPriceSource {
  abstract getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null>
}

export abstract class HistoricalPriceSourceBase
  extends PriceSourceBase
  implements HistoricalPriceSource
{
  abstract getHistoricalPrice(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPriceResult | null>
}
