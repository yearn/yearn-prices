import type { Pool } from '@neondatabase/serverless'
import { ApiError } from '@/lib/api/errors'
import { jsonResponse } from '@/lib/api/http'
import { parseTokenKey } from '@/lib/chains'
import { cacheControlForHistorical, CACHE_CONTROL_NOT_FOUND } from '@/lib/prices/cache'
import { getExactHistoricalPrice } from '@/lib/prices/queries'
import type { Env } from '@/lib/prices/types'
import { parseOptionalSource, parseTimestampSegment } from '@/lib/prices/validation'

export function notFoundErrorHeaders(): HeadersInit {
  return { 'cache-control': CACHE_CONTROL_NOT_FOUND }
}

export async function handleHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
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
          source: record.source,
        },
      },
    },
    {
      headers: {
        'cache-control': cacheControlForHistorical(record.timestamp),
      },
    },
  )
}
