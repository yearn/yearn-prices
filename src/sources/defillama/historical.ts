import { DefiLlamaClient } from '../../clients/defillama'
import { chainIdToName } from '../../utils/chains'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalPriceResult } from '../types'
import { toHistoricalPrice } from './coin'

export class DefiLlamaHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'defillama'
  readonly priority = 10

  constructor(private readonly client: DefiLlamaClient = new DefiLlamaClient()) {
    super()
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined
  }

  async getHistoricalPrice(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPriceResult | null> {
    const chain = chainIdToName(chainId)
    if (!chain) {
      return null
    }

    const coinKey = `${chain}:${token.toLowerCase()}`
    const response = await this.client.getHistorical(timestamp, [coinKey])

    return toHistoricalPrice(response.coins?.[coinKey], (price, time) =>
      this.isUsablePrice(price, time),
    )
  }
}

export function createDefiLlamaHistoricalSource(
  client?: DefiLlamaClient,
): DefiLlamaHistoricalSource {
  return new DefiLlamaHistoricalSource(client)
}
