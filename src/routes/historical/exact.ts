import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import type { Env } from '../../types'
import { parseOptionalSource, parseTimestampSegment, parseTokenKey } from '../../utils'
import { type ReadThroughUpstream, readThrough } from './read-through'

export async function handleHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  upstream?: ReadThroughUpstream
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const row = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
  // Today is always read live from DeFiLlama /prices/current; a closed-day table miss is filled once from
  // /batchHistorical and persisted, so the next read is a table hit. Explicit-source requests stay table-only.
  // A failed upstream with nothing to serve is a 503, never a cacheable 404.
  const result = await readThrough(pool, [{ chain, token, timestamp }], row ? [row] : [], source, upstream)
  const [record] = result.rows
  if (!record) {
    if (result.upstreamFailed) {
      throw new ApiError('UNAVAILABLE', `Upstream price lookup failed for ${tokenKey} at ${timestamp}`)
    }
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
