import type { DefiLlamaClient } from '../clients/defillama'
import { chainIdToName } from '../utils/chains'
import type { HistoricalPriceSource } from './types'

export function createDefiLlamaHistoricalSource(client: DefiLlamaClient): HistoricalPriceSource {
  return {
    name: 'defillama',
    priority: 10,
    supports: (chainId: number) => chainIdToName(chainId) !== undefined,
    async getHistoricalPrice(chainId: number, token: string, timestamp: number) {
      const chain = chainIdToName(chainId)
      if (!chain) {
        return null
      }

      const coinKey = `${chain}:${token.toLowerCase()}`
      const response = await client.getHistorical(timestamp, [coinKey])
      const priceData = response.coins?.[coinKey]

      if (
        !priceData ||
        typeof priceData.price !== 'number' ||
        !Number.isFinite(priceData.price) ||
        priceData.price <= 0 ||
        typeof priceData.timestamp !== 'number' ||
        !Number.isFinite(priceData.timestamp) ||
        priceData.timestamp <= 0
      ) {
        return null
      }

      return {
        price: priceData.price,
        timestamp: priceData.timestamp,
        symbol: priceData.symbol ?? null,
        confidence: priceData.confidence ?? null
      }
    }
  }
}
