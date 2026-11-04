import type { Pool } from '@neondatabase/serverless'
import { cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import { type SpotSourceRegistry, spotSourceRegistry } from '../../registries'
import type { Env, ExactPriceRecord, PriceSource } from '../../types'
import {
  chainNameToId,
  isTodayNormalized,
  parseOptionalSource,
  parseTimestampSegment,
  parseTokenKey
} from '../../utils'

const SPOT_DEADLINE_MS = 15_000

export async function handleHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  registry: (env: Env) => SpotSourceRegistry = spotSourceRegistry
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const record =
    (await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)) ??
    (await spotForToday(env, registry, chain, token, timestamp, source))
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
// day is served live from the spot sources, never persisted: a mid-day spot price is not
// the day's close. Explicit-source requests stay table-only. A spot NOT_FOUND falls through
// to the historical 404; any other spot failure propagates so it is not cached as a miss.
async function spotForToday(
  env: Env,
  registry: (env: Env) => SpotSourceRegistry,
  chain: string,
  token: string,
  timestamp: number,
  source?: PriceSource
): Promise<ExactPriceRecord | null> {
  if (source || !isTodayNormalized(timestamp) || !env.ENSO_API_KEY) return null
  const chainId = chainNameToId(chain)
  if (chainId === undefined) return null

  try {
    const spot = await registry(env).resolve(chainId, token.toLowerCase(), AbortSignal.timeout(SPOT_DEADLINE_MS))
    return {
      chain,
      token,
      timestamp: spot.timestamp,
      price: spot.price,
      symbol: spot.symbol,
      confidence: spot.confidence,
      source: spot.source as PriceSource
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') return null
    throw error
  }
}
