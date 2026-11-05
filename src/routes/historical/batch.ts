import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import type { Env } from '../../types'
import { isTodayNormalized, parseBatchCoins, parseOptionalSource } from '../../utils'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'
import { type FetchCurrent, refreshStaleToday } from './today'

export async function handleBatchHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  fetchCurrent?: FetchCurrent
): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseBatchCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const rows = await refreshStaleToday(
    pool,
    requests.filter((entry) => isTodayNormalized(entry.timestamp)),
    await getBatchHistoricalPrices(pool, requests, source),
    source,
    fetchCurrent
  )

  const coins = groupRowsByToken(rows, originalKeyMap)

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
