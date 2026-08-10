import { EnsoClient } from '../../clients/enso'
import { ApiError } from '../../http/errors'
import { chainIdToName, nowUnix, toUnixSeconds } from '../../utils'
import { SpotPriceSourceBase } from '../base'
import type { SpotPriceResult } from '../types'

export class EnsoSpotSource extends SpotPriceSourceBase {
  readonly name = 'enso'
  readonly priority = 10

  private readonly client: EnsoClient

  constructor(apiKey: string) {
    super()
    this.client = new EnsoClient(apiKey)
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined
  }

  async getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult> {
    const priceData = await this.client.getPrice(chainId, token.toLowerCase())

    if (
      typeof priceData.price !== 'number' ||
      !Number.isFinite(priceData.price) ||
      priceData.price <= 0
    ) {
      throw new ApiError('NOT_FOUND', `Enso returned no valid price for ${token}`)
    }

    // Enso reports milliseconds, and omits the field often enough that the
    // request time is the only honest fallback.
    const timestamp =
      typeof priceData.timestamp === 'number' &&
      Number.isFinite(priceData.timestamp) &&
      priceData.timestamp > 0
        ? toUnixSeconds(priceData.timestamp)
        : nowUnix()

    return {
      price: priceData.price,
      timestamp,
      symbol: priceData.symbol ?? null,
      confidence: priceData.confidence ?? null,
    }
  }
}

export function createEnsoSpotSource(apiKey: string): EnsoSpotSource {
  return new EnsoSpotSource(apiKey)
}
