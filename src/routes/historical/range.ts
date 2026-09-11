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
  const rawCoins = url.searchParams.get('coins')
  const requests = parseRangeCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const rows = await getRangeHistoricalPrices(pool, requests, source)

  const grouped = groupRowsByToken(rows, originalKeyMap)

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
