import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import type { Env } from '../../types'
import { parseOptionalSource, parseTimestampSegment, parseTokenKey } from '../../utils'

export async function handleHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const record = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
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
