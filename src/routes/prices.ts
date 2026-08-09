import type { Pool } from '@neondatabase/serverless'
import {
  CACHE_CONTROL_NOT_FOUND,
  CACHE_CONTROL_SPOT,
  cacheControlForBatch,
  cacheControlForHistorical,
  cacheControlForRange
} from '../cache'
import { chainNameToId, parseTokenKey } from '../chains'
import { EnsoClient } from '../enso'
import { ApiError, ensure, errorEnvelope } from '../errors'
import { jsonResponse } from '../http'
import { getBatchHistoricalPrices, getExactHistoricalPrice, getRangeHistoricalPrices } from '../queries'
import { normalizedDaysInRange, nowUnix, toUnixSeconds } from '../time'
import type {
  BatchHistoricalResponseCoin,
  Env,
  ExactPriceRecord,
  HistoricalRequestTuple,
  RangeRequest,
  SpotRequest,
  SpotResponseCoin
} from '../types'
import {
  parseBatchCoins,
  parseOptionalSource,
  parseRangeCoins,
  parseSpotCoins,
  parseTimestampSegment
} from '../validation'

function buildTokenKey(chain: string, token: string): string {
  return `${chain}:${token}`
}

function buildOriginalKeyMap(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const originalKey of Object.keys(parsed)) {
      try {
        const { chain, token } = parseTokenKey(originalKey)
        const normalizedKey = buildTokenKey(chain, token)
        if (!map.has(normalizedKey)) {
          map.set(normalizedKey, originalKey)
        }
      } catch {}
    }
  } catch {}
  return map
}

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

// Stateless proxy for live spot prices from Enso. Intentionally does not persist:
// spot is a latest-price use case served by the edge cache, and writing a mid-day
// spot price as that day's historical close would corrupt the price history.
export async function handleSpot(request: Request, env: Env): Promise<Response> {
  ensure(env.ENSO_API_KEY, 'INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  const requests = parseSpotCoins(new URL(request.url).searchParams.get('coins'))

  const enso = new EnsoClient(env.ENSO_API_KEY)
  const settled = await Promise.allSettled(
    requests.map(
      async (
        req
      ): Promise<{
        req: SpotRequest
        timestamp: number
        symbol: string | null
        price: number
        confidence: number | null
      }> => {
        const chainId = chainNameToId(req.chain)
        ensure(chainId !== undefined, 'INVALID_INPUT', `Unsupported chain: ${req.chain}`)

        const priceData = await enso.getPrice(chainId, req.token.toLowerCase())
        ensure(
          typeof priceData.price === 'number' && Number.isFinite(priceData.price) && priceData.price > 0,
          'NOT_FOUND',
          `Enso returned no valid price for ${req.originalKey}`
        )

        // Live spot timestamp: Enso reports unix milliseconds, converted to seconds
        // (or "now" when omitted). Not normalized to a day-end — this is a spot price.
        const timestamp =
          typeof priceData.timestamp === 'number' && Number.isFinite(priceData.timestamp) && priceData.timestamp > 0
            ? toUnixSeconds(priceData.timestamp)
            : nowUnix()

        return {
          req,
          timestamp,
          symbol: priceData.symbol ?? null,
          price: priceData.price,
          confidence: priceData.confidence ?? null
        }
      }
    )
  )

  const coins: Record<string, SpotResponseCoin> = {}

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      const tokenKey = requests[i].originalKey
      const reason = outcome.reason
      console.error(
        JSON.stringify({
          message: 'enso-spot-error',
          token_key: tokenKey,
          error: reason instanceof Error ? reason.message : String(reason)
        })
      )
      // Same envelope as jsonError: { error: { code, message } }.
      // NOT_FOUND = no price (permanent); anything else is retryable.
      coins[tokenKey] =
        reason instanceof ApiError && reason.code === 'NOT_FOUND'
          ? errorEnvelope('NOT_FOUND', 'No price available for this token')
          : errorEnvelope('UNAVAILABLE', 'Price temporarily unavailable, please retry')
      continue
    }

    const { req, timestamp, symbol, price, confidence } = outcome.value
    coins[req.originalKey] = {
      symbol,
      prices: [{ timestamp, price, confidence, source: 'enso' }]
    }
  }

  return jsonResponse(
    { coins },
    {
      headers: {
        'cache-control': CACHE_CONTROL_SPOT
      }
    }
  )
}

export async function handleBatchHistorical(request: Request, _env: Env, pool: Pool): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseBatchCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const rows = await getBatchHistoricalPrices(pool, requests, source)

  const coins = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const normalizedKey = buildTokenKey(row.chain, row.token)
    const tokenKey = originalKeyMap.get(normalizedKey) ?? normalizedKey
    const current = coins.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source
    })
    if (!current.symbol && row.symbol) {
      current.symbol = row.symbol
    }
    coins.set(tokenKey, current)
  }

  for (const coin of coins.values()) {
    coin.prices.sort((left, right) => left.timestamp - right.timestamp)
  }

  const requestedKeyCount = new Set(requests.map(toExactKey)).size
  const allResolved = rows.length === requestedKeyCount
  return jsonResponse(
    { coins: Object.fromEntries(coins.entries()) },
    {
      headers: {
        'cache-control': cacheControlForBatch(
          requests.map((entry) => entry.timestamp),
          allResolved
        )
      }
    }
  )
}

export async function handleRangeHistorical(request: Request, _env: Env, pool: Pool): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseRangeCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const rows = await getRangeHistoricalPrices(pool, requests, source)

  const grouped = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const normalizedKey = buildTokenKey(row.chain, row.token)
    const tokenKey = originalKeyMap.get(normalizedKey) ?? normalizedKey
    const current = grouped.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source
    })
    if (!current.symbol && row.symbol) {
      current.symbol = row.symbol
    }
    grouped.set(tokenKey, current)
  }

  for (const coin of grouped.values()) {
    coin.prices.sort((left, right) => left.timestamp - right.timestamp)
  }

  const expectedTimestamps = new Set<string>()
  for (const requestRange of requests) {
    for (const timestamp of normalizedDaysInRange(requestRange.startTimestamp, requestRange.endTimestamp)) {
      expectedTimestamps.add(`${requestRange.chain}:${requestRange.token}:${timestamp}`)
    }
  }

  const resolvedTimestamps = new Set(rows.map(toExactKey))
  const allResolved = resolvedTimestamps.size === expectedTimestamps.size

  return jsonResponse(
    { coins: Object.fromEntries(grouped.entries()) },
    {
      headers: {
        'cache-control': cacheControlForRange(
          requests.map((entry) => entry.endTimestamp),
          allResolved
        )
      }
    }
  )
}

export function notFoundErrorHeaders(): HeadersInit {
  return { 'cache-control': CACHE_CONTROL_NOT_FOUND }
}

function toExactKey(entry: HistoricalRequestTuple | RangeRequest | ExactPriceRecord): string {
  if ('timestamp' in entry) {
    return `${entry.chain}:${entry.token}:${entry.timestamp}`
  }

  const timestamps = normalizedDaysInRange(entry.startTimestamp, entry.endTimestamp)
  ensure(timestamps.length > 0, 'INTERNAL_ERROR', 'Unexpected empty range')
  return `${entry.chain}:${entry.token}:${timestamps[0]}`
}
