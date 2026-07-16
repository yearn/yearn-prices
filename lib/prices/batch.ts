import type { Pool } from '@neondatabase/serverless'
import { jsonResponse } from '@/lib/api/http'
import { cacheControlForBatch } from '@/lib/prices/cache'
import { buildOriginalKeyMap, buildTokenKey, toExactKey } from '@/lib/prices/keys'
import { getBatchHistoricalPrices } from '@/lib/prices/queries'
import type { BatchHistoricalResponseCoin, Env } from '@/lib/prices/types'
import { parseBatchCoins, parseOptionalSource } from '@/lib/prices/validation'

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
        'cache-control': cacheControlForBatch(
          requests.map(entry => entry.timestamp),
          allResolved,
        ),
      },
    },
  )
}
