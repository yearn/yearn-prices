import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE, cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import type { Env } from '../../types'
import { parseBatchCoins, parseOptionalSource } from '../../utils'
import { type ReadThroughUpstream, readThrough } from './read-through'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'

export async function handleBatchHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  upstream?: ReadThroughUpstream
): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseBatchCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const { rows, upstreamFailed } = await readThrough(
    pool,
    requests,
    await getBatchHistoricalPrices(pool, requests, source),
    source,
    upstream
  )

  const coins = groupRowsByToken(rows, originalKeyMap)

  const requestedKeyCount = new Set(requests.map(toExactKey)).size
  const allResolved = rows.length === requestedKeyCount
  return jsonResponse(
    { coins: Object.fromEntries(coins.entries()) },
    {
      headers: {
        'cache-control':
          upstreamFailed && !allResolved
            ? CACHE_CONTROL_NO_STORE
            : cacheControlForBatch(
                requests.map((entry) => entry.timestamp),
                allResolved
              )
      }
    }
  )
}
