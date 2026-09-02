import type { Pool } from '@neondatabase/serverless'
import {
  CACHE_CONTROL_NO_STORE,
  CACHE_CONTROL_PARTIAL,
  CACHE_CONTROL_TODAY,
  cacheControlForHistorical
} from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { HistoricalPrice } from '../../sources/types'
import type { Env, ExactPriceRecord } from '../../types'
import {
  chainNameToId,
  isTodayNormalized,
  parseOptionalSource,
  parseTimestampSegment,
  parseTokenKey,
  toFetchTimestamp
} from '../../utils'
import { persistResolvedPrices, toResolvedRecord } from './persist'
import { isNotFound } from './shared'

function respond(tokenKeySegment: string, record: ExactPriceRecord, cacheControl: string): Response {
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
    { headers: { 'cache-control': cacheControl } }
  )
}

async function resolveUpstream(
  registry: HistoricalSourceRegistry,
  chainId: number,
  token: string,
  timestamp: number
): Promise<HistoricalPrice | null> {
  try {
    return await registry.resolve(chainId, token, toFetchTimestamp(timestamp))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function handleHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  registry: HistoricalSourceRegistry = historicalSourceRegistry(env)
): Promise<Response> {
  const timestamp = parseTimestampSegment(timestampSegment)
  const { chain, token, tokenKey } = parseTokenKey(tokenKeySegment)
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))

  const stored = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
  if (stored) {
    return respond(tokenKeySegment, stored, cacheControlForHistorical(stored.timestamp))
  }

  const chainId = chainNameToId(chain)
  const historical = source || chainId === undefined ? null : await resolveUpstream(registry, chainId, token, timestamp)
  if (!historical) {
    throw new ApiError('NOT_FOUND', `No historical price found for ${tokenKey} at ${timestamp}`)
  }

  const record = toResolvedRecord({ chain, token, timestamp }, historical)
  const persisted = await persistResolvedPrices(pool, [record])
  const cacheControl = !persisted
    ? CACHE_CONTROL_NO_STORE
    : isTodayNormalized(timestamp)
      ? CACHE_CONTROL_TODAY
      : CACHE_CONTROL_PARTIAL
  return respond(tokenKeySegment, record, cacheControl)
}
