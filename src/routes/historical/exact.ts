import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import { writeDown } from '../../prices/write-downs'
import type { Env } from '../../types'
import { parseOptionalSource, parseTimestampSegment, parseTokenKey } from '../../utils'
import { type ReadThroughUpstream, readThrough } from './read-through'

export async function handleHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  upstream?: ReadThroughUpstream
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const override = writeDown(chain, token, timestamp, source)
  if (override)
    return jsonResponse(
      { coins: { [tokenKeySegment]: override } },
      { headers: { 'cache-control': cacheControlForHistorical(timestamp) } }
    )

  const row = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
  // Today is always read live from DeFiLlama /prices/current; a closed-day table miss is filled from
  // /batchHistorical and persisted (finalized only once the Curve LP guard checked it, else provisional for
  // warmup/backfill to finalize). Explicit-source requests stay table-only.
  // A failed upstream with nothing to serve is a 503, never a cacheable 404.
  const result = await readThrough(pool, env, [{ chain, token, timestamp }], row ? [row] : [], source, upstream)
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
