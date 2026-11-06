import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE, cacheControlForRange } from '../../cache'
import { getRangeHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import { writeDown } from '../../prices/write-downs'
import type { Env } from '../../types'
import { normalizedDaysInRange, parseOptionalSource, parseRangeCoins } from '../../utils'
import { type ReadThroughUpstream, readThrough } from './read-through'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'

export async function handleRangeHistorical(
  request: Request,
  env: Env,
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
  const overrides = expectedRequests.flatMap((entry) => {
    const price = writeDown(entry.chain, entry.token, entry.timestamp, source)
    return price ? [{ ...entry, ...price }] : []
  })
  const pending = expectedRequests.filter((entry) => !writeDown(entry.chain, entry.token, entry.timestamp, source))
  const pendingRanges = requests.flatMap((entry) => {
    const days = pending.filter((day) => day.chain === entry.chain && day.token === entry.token)
    return days.length ? [{ ...entry, endTimestamp: days[days.length - 1].timestamp }] : []
  })
  const { rows, upstreamFailed } = await readThrough(
    pool,
    env,
    pending,
    await getRangeHistoricalPrices(pool, pendingRanges, source),
    source,
    upstream
  )

  const responseRows = [...rows, ...overrides]

  const grouped = groupRowsByToken(responseRows, originalKeyMap)

  const resolvedTimestamps = new Set([...rows, ...overrides].map((entry) => toExactKey(entry)))
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
