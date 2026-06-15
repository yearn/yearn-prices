import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch, cacheControlForHistorical, cacheControlForRange, CACHE_CONTROL_NOT_FOUND } from '../cache'
import { chainIdToName, normalizeTokenAddress, parseTokenKey } from '../chains'
import { EnsoClient } from '../enso'
import { ApiError, ensure } from '../errors'
import { jsonResponse } from '../http'
import { getBatchHistoricalPrices, getExactHistoricalPrice, getRangeHistoricalPrices, insertTokenPrices } from '../queries'
import { normalizedDaysInRange, normalizeToEndOfDay, nowUnix } from '../time'
import type { BatchHistoricalResponseCoin, Env, ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '../types'
import { parseBatchCoins, parseOptionalSource, parseRangeCoins, parseTimestampSegment } from '../validation'

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

export async function handleCurrent(env: Env, pool: Pool, chainIdSegment: string, tokenAddressSegment: string): Promise<Response> {
  ensure(env.ENSO_API_KEY, 'INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  ensure(/^\d+$/.test(chainIdSegment), 'INVALID_INPUT', 'Chain id must be a number')
  const chainId = Number(chainIdSegment)
  const chain = chainIdToName(chainId)
  ensure(chain !== undefined, 'INVALID_INPUT', `Unsupported chain id: ${chainId}`)

  let token: `0x${string}`
  try {
    token = normalizeTokenAddress(tokenAddressSegment)
  } catch {
    throw new ApiError('INVALID_INPUT', `Unsupported token address: ${tokenAddressSegment}`)
  }
  const tokenKey = buildTokenKey(chain, token)

  const enso = new EnsoClient(env.ENSO_API_KEY)
  const priceData = await enso.getPrice(chainId, token.toLowerCase())

  ensure(
    typeof priceData.price === 'number' && Number.isFinite(priceData.price) && priceData.price > 0,
    'NOT_FOUND',
    `Enso returned no valid price for ${tokenKey}`,
  )

  const priceTimestamp =
    typeof priceData.timestamp === 'number' && Number.isFinite(priceData.timestamp) && priceData.timestamp > 0
      ? priceData.timestamp
      : nowUnix()
  const timestamp = normalizeToEndOfDay(priceTimestamp)
  const symbol = priceData.symbol ?? null
  const confidence = priceData.confidence ?? null

  try {
    await insertTokenPrices(pool, [
      {
        chain,
        token,
        timestamp,
        price: priceData.price,
        symbol,
        confidence,
        source: 'enso',
      },
    ])
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'enso-persist-error',
        token_key: tokenKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  return jsonResponse(
    {
      coins: {
        [tokenKey]: {
          price: priceData.price,
          symbol,
          timestamp,
          confidence,
          source: 'enso',
        },
      },
    },
    {
      headers: {
        'cache-control': cacheControlForHistorical(timestamp),
      },
    },
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
