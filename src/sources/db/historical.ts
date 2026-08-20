import type { Pool } from '@neondatabase/serverless'
import { getExactHistoricalPrice } from '../../db'
import { chainIdToName } from '../../utils/chains'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalPriceResult } from '../types'

export class DbHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'db'
  readonly priority = 0

  constructor(private readonly pool: Pool) {
    super()
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    const chain = chainIdToName(chainId)
    if (!chain) {
      return null
    }
    return getExactHistoricalPrice(this.pool, { chain, token, timestamp })
  }
}

export function createDbHistoricalSource(pool: Pool): DbHistoricalSource {
  return new DbHistoricalSource(pool)
}
