import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch, cacheControlForHistorical, cacheControlForRange, CACHE_CONTROL_NOT_FOUND } from '../cache'
import { parseTokenKey } from '../chains'
import { ApiError, ensure } from '../errors'
import { jsonResponse } from '../http'
import { getBatchHistoricalPrices, getExactHistoricalPrice, getRangeHistoricalPrices } from '../queries'
import { normalizedDaysInRange } from '../time'
import type { BatchHistoricalResponseCoin, Env, ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '../types'
import { parseBatchCoins, parseOptionalSource, parseRangeCoins, parseTimestampSegment } from '../validation'

function buildTokenKey(chain: string, token: string): string {
  return `${chain}:${token}`
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
        [tokenKey]: {
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

export async function handleBatchHistorical(request: Request, _env: Env, pool: Pool): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const requests = parseBatchCoins(url.searchParams.get('coins'))
  const rows = await getBatchHistoricalPrices(pool, requests, source)

  const coins = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const tokenKey = buildTokenKey(row.chain, row.token)
    const current = coins.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source,
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
        'cache-control': cacheControlForBatch(requests.map(entry => entry.timestamp), allResolved),
      },
    },
  )
}

export async function handleRangeHistorical(request: Request, _env: Env, pool: Pool): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const requests = parseRangeCoins(url.searchParams.get('coins'))
  const rows = await getRangeHistoricalPrices(pool, requests, source)

  const grouped = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const tokenKey = buildTokenKey(row.chain, row.token)
    const current = grouped.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source,
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
        'cache-control': cacheControlForRange(requests.map(entry => entry.endTimestamp), allResolved),
      },
    },
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
