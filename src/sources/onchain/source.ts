import { HistoricalPriceSourceBase, SpotPriceSourceBase } from '../base'
import type { HistoricalPriceResult, SpotPriceResult } from '../types'
import { DEFAULT_PRIORITY, ONCHAIN_SOURCE_NAME, type OnchainSourceOptions } from './options'
import { OnchainPricer } from './pricer'

export { ONCHAIN_SOURCE_NAME } from './options'
export type { OnchainSourceOptions } from './options'

export class OnchainSpotSource extends SpotPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null> {
    return this.pricer.price({ chainId, token, timestamp: null })
  }
}

export class OnchainHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    return this.pricer.price({ chainId, token, timestamp })
  }
}

export function createOnchainSpotSource(options: OnchainSourceOptions): OnchainSpotSource {
  return new OnchainSpotSource(options)
}

export function createOnchainHistoricalSource(options: OnchainSourceOptions): OnchainHistoricalSource {
  return new OnchainHistoricalSource(options)
}
