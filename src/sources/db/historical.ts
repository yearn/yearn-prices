import type { Pool } from '@neondatabase/serverless'
import { getExactHistoricalPrice } from '../../db'
import { ApiError } from '../../http/errors'
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
    // A failed query is an outage, not an absent price: returning null here
    // would let the engine report the token as never priced.
    let record: Awaited<ReturnType<typeof getExactHistoricalPrice>>
    try {
      record = await getExactHistoricalPrice(this.pool, { chain, token, timestamp })
    } catch (error) {
      throw new ApiError('UNAVAILABLE', `db price lookup failed: ${error instanceof Error ? error.message : error}`)
    }
    if (!record || !this.isUsablePrice(record.price, record.timestamp)) {
      return null
    }
    return record
  }
}

export function createDbHistoricalSource(pool: Pool): DbHistoricalSource {
  return new DbHistoricalSource(pool)
}
