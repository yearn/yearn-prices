import { EnsoClient } from '../clients/enso'
import { ApiError } from '../http/errors'
import { chainIdToName, nowUnix, toUnixSeconds } from '../utils'
import type { SpotPriceSource } from './types'

export function createEnsoSpotSource(apiKey: string): SpotPriceSource {
  const client = new EnsoClient(apiKey)

  return {
    name: 'enso',
    priority: 10,
    supports: (chainId: number) => chainIdToName(chainId) !== undefined,
    async getSpotPrice(chainId: number, token: string) {
      const priceData = await client.getPrice(chainId, token.toLowerCase())

      if (
        typeof priceData.price !== 'number' ||
        !Number.isFinite(priceData.price) ||
        priceData.price <= 0
      ) {
        throw new ApiError('NOT_FOUND', `Enso returned no valid price for ${token}`)
      }

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
    },
  }
}
