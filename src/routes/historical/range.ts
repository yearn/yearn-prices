import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE, cacheControlForRange } from '../../cache'
import { getRangeHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import type { Env } from '../../types'
import { normalizedDaysInRange, parseOptionalSource, parseRangeCoins } from '../../utils'
import { type ReadThroughUpstream, readThrough } from './read-through'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'

export async function handleRangeHistorical(
  request: Request,
  _env: Env,
  pool: Pool,
  upstream?: ReadThroughUpstream
): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseRangeCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const expectedRequests = requests.flatMap(({ chain, token, startTimestamp, endTimestamp }) =>
    normalizedDaysInRange(startTimestamp, endTimestamp).map((timestamp) => ({ chain, token, timestamp }))
  )
  const { rows, upstreamFailed } = await readThrough(
    pool,
    expectedRequests,
    await getRangeHistoricalPrices(pool, requests, source),
    source,
    upstream
  )

  const grouped = groupRowsByToken(rows, originalKeyMap)

  const resolvedTimestamps = new Set(rows.map(toExactKey))
  const allResolved = resolvedTimestamps.size === expectedRequests.length

  return jsonResponse(
    { coins: Object.fromEntries(grouped.entries()) },
    {
      headers: {
        'cache-control':
          upstreamFailed && !allResolved
            ? CACHE_CONTROL_NO_STORE
            : cacheControlForRange(
                requests.map((entry) => entry.endTimestamp),
                allResolved
              )
      }
    }
  )
}
