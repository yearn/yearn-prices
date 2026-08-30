import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_PARTIAL, CACHE_CONTROL_TODAY, cacheControlForHistorical } from '../../cache'
import { getExactHistoricalPrice } from '../../db'
import { ApiError, jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { Env, PriceSource } from '../../types'
import {
  chainNameToId,
  isTodayNormalized,
  parseOptionalSource,
  parseTimestampSegment,
  parseTokenKey,
  toFetchTimestamp
} from '../../utils'
import { persistResolvedPrices } from './shared'

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

  const record = await getExactHistoricalPrice(pool, { chain, token, timestamp }, source)
  if (!record && !source) {
    const chainId = chainNameToId(chain)
    if (chainId !== undefined) {
      try {
        const historical = await registry.resolve(chainId, token, toFetchTimestamp(timestamp))

        // Persist under the normalized day key so the next request — and the
        // batch route — is a table hit instead of another upstream resolution.
        await persistResolvedPrices(pool, [
          {
            chain,
            token,
            timestamp,
            price: historical.price,
            symbol: historical.symbol,
            confidence: historical.confidence,
            source: historical.source as PriceSource,
            observedAt: historical.timestamp
          }
        ])

        return jsonResponse(
          {
            coins: {
              [tokenKeySegment]: {
                price: historical.price,
                symbol: historical.symbol,
                timestamp,
                confidence: historical.confidence,
                source: historical.source
              }
            }
          },
          {
            headers: {
              'cache-control': isTodayNormalized(timestamp) ? CACHE_CONTROL_TODAY : CACHE_CONTROL_PARTIAL
            }
          }
        )
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) {
          throw error
        }
      }
    }
  }

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
