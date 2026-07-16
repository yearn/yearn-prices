import type { Pool } from '@neondatabase/serverless'
import { jsonResponse } from '@/lib/api/http'
import { cacheControlForRange } from '@/lib/prices/cache'
import { buildOriginalKeyMap, buildTokenKey, toExactKey } from '@/lib/prices/keys'
import { getRangeHistoricalPrices } from '@/lib/prices/queries'
import type { BatchHistoricalResponseCoin, Env } from '@/lib/prices/types'
import { parseOptionalSource, parseRangeCoins } from '@/lib/prices/validation'
import { normalizedDaysInRange } from '@/lib/time'

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
        'cache-control': cacheControlForRange(
          requests.map(entry => entry.endTimestamp),
          allResolved,
        ),
      },
    },
  )
}
