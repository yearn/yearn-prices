import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { DefiLlamaClient } from '../../clients/defillama'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import { createDefiLlamaHistoricalSource } from '../../sources'
import type { HistoricalPriceSource } from '../../sources/types'
import type { Env, ExactPriceRecord, PriceSource } from '../../types'
import {
  chainNameToId,
  isTodayNormalized,
  parseOptionalSource,
  parseTimestampSegment,
  parseTokenKey,
  toFetchTimestamp
} from '../../utils'

const FALLBACK_TIMEOUT_MS = 2_500

function defiLlamaFallback(): HistoricalPriceSource {
  return createDefiLlamaHistoricalSource(
    new DefiLlamaClient(undefined, undefined, { timeoutMs: FALLBACK_TIMEOUT_MS, retryRateLimits: false })
  )
}

export async function handleHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  fallback: () => HistoricalPriceSource = defiLlamaFallback
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const record =
    (await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)) ??
    (await upstreamForToday(fallback, chain, token, timestamp, source))
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

// Today's row only exists once the hourly warmup has written it. Until then the current
// day is answered by one bounded DeFiLlama call, never persisted. Explicit-source requests
// stay table-only. No price falls through to the historical 404; any other failure
// propagates so it is not cached as a miss.
async function upstreamForToday(
  fallback: () => HistoricalPriceSource,
  chain: string,
  token: string,
  timestamp: number,
  source?: PriceSource
): Promise<ExactPriceRecord | null> {
  if (source || !isTodayNormalized(timestamp)) return null
  const chainId = chainNameToId(chain)
  if (chainId === undefined) return null

  const upstream = fallback()
  if (!upstream.supports(chainId)) return null
  const price = await upstream.getHistoricalPrice(chainId, token.toLowerCase(), toFetchTimestamp(timestamp))
  if (!price) return null
  return {
    chain,
    token,
    timestamp: price.timestamp,
    price: price.price,
    symbol: price.symbol,
    confidence: price.confidence,
    source: upstream.name as PriceSource
  }
}
