import type { Pool } from '@neondatabase/serverless'
import { cacheControlForRange } from '../../cache'
import { getRangeHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import type { Env } from '../../types'
import { normalizedDaysInRange, parseOptionalSource, parseRangeCoins } from '../../utils'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'

export async function handleRangeHistorical(request: Request, _env: Env, pool: Pool): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins') ?? ''
  const requests = parseRangeCoins(rawCoins)
  const rows = await getRangeHistoricalPrices(pool, requests, source)

  const expected = new Set(
    requests.flatMap(({ chain, token, startTimestamp, endTimestamp }) =>
      normalizedDaysInRange(startTimestamp, endTimestamp).map((timestamp) => toExactKey({ chain, token, timestamp }))
    )
  )
  const found = new Set(rows.map(toExactKey))

  return jsonResponse(
    { coins: Object.fromEntries(groupRowsByToken(rows, buildOriginalKeyMap(rawCoins))) },
    {
      headers: {
        'cache-control': cacheControlForRange(
          requests.map((entry) => entry.endTimestamp),
          found.size === expected.size
        )
      }
    }
  )
}
