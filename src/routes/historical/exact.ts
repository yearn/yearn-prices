import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import type { Env } from '../../types'
import { isTodayNormalized, parseOptionalSource, parseTimestampSegment, parseTokenKey } from '../../utils'
import { type FetchCurrent, refreshStaleToday } from './today'

export async function handleHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  fetchCurrent?: FetchCurrent
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const row = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
  // Today's row missing or older than 5 minutes is refreshed from one bounded DeFiLlama
  // /prices/current call and persisted as provisional. Explicit-source requests stay table-only.
  // An upstream failure with no stored row propagates so it is not cached as a miss.
  const [record] = await refreshStaleToday(
    pool,
    isTodayNormalized(timestamp) ? [{ chain, token, timestamp }] : [],
    row ? [row] : [],
    source,
    fetchCurrent
  )
  if (!record) {
    throw new ApiError('NOT_FOUND', `No historical price found for ${tokenKey} at ${timestamp}`)
  }

  return jsonResponse(
    {
      coins: {
        [tokenKeySegment]: {
          price: record.price,
          symbol: record.symbol,
          timestamp: record.timestamp,
          confidence: record.confidence,
          source: record.source
        }
      }
    },
    {
      headers: {
        'cache-control': cacheControlForHistorical(record.timestamp)
      }
    }
  )
}
