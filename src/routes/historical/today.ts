import type { Pool } from '@neondatabase/serverless'
import { DefiLlamaClient } from '../../clients/defillama'
import { insertProvisionalTokenPrices } from '../../db'
import { type CurrentPriceTarget, currentPriceKey, fetchCurrentPrices } from '../../sources/defillama/current'
import type { HistoricalPriceResult } from '../../sources/types'
import type { ExactPriceRecord, HistoricalRequestTuple, PriceSource, TokenPriceWrite } from '../../types'
import { currentUtcDayEnd, nowUnix } from '../../utils/time'

export const TODAY_STALE_AFTER_SECONDS = 300
const CURRENT_TIMEOUT_MS = 2_500

export type FetchCurrent = (targets: CurrentPriceTarget[]) => Promise<Map<string, HistoricalPriceResult>>

const defaultFetchCurrent: FetchCurrent = (targets) =>
  fetchCurrentPrices(
    new DefiLlamaClient(undefined, undefined, { timeoutMs: CURRENT_TIMEOUT_MS, retryRateLimits: false }),
    targets
  )

export async function refreshStaleToday(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  rows: ExactPriceRecord[],
  source: PriceSource | undefined,
  fetchCurrent: FetchCurrent = defaultFetchCurrent
): Promise<ExactPriceRecord[]> {
  if (source || requests.length === 0) return rows

  const todayEnd = currentUtcDayEnd()
  const todayRows = new Map<string, ExactPriceRecord>()
  for (const row of rows) {
    if (row.timestamp === todayEnd) todayRows.set(currentPriceKey(row.chain, row.token), row)
  }

  const staleBefore = nowUnix() - TODAY_STALE_AFTER_SECONDS
  const stale = new Map<string, CurrentPriceTarget>()
  for (const { chain, token } of requests) {
    const key = currentPriceKey(chain, token)
    const row = todayRows.get(key)
    if (!row || row.updatedAt == null || row.updatedAt < staleBefore) stale.set(key, { chain, token })
  }
  if (stale.size === 0) return rows

  let fetched: Map<string, HistoricalPriceResult>
  try {
    fetched = await fetchCurrent([...stale.values()])
  } catch (error) {
    if ([...stale.keys()].some((key) => !todayRows.has(key))) throw error
    console.error(JSON.stringify({ message: 'today-refresh-failed', targets: stale.size, error: String(error) }))
    return rows
  }

  const writes: TokenPriceWrite[] = []
  const fresh = new Map<string, ExactPriceRecord>()
  const updatedAt = nowUnix()
  for (const [key, { chain, token }] of stale) {
    const price = fetched.get(key)
    if (!price) continue
    writes.push({
      chain,
      token,
      timestamp: todayEnd,
      price: price.price,
      symbol: price.symbol,
      confidence: price.confidence,
      source: 'defillama',
      observedTimestamp: price.timestamp,
      observationEndpoint: '/prices/current',
      finalizationIntent: 'provisional'
    })
    fresh.set(key, {
      chain,
      token,
      timestamp: todayEnd,
      price: price.price,
      symbol: price.symbol,
      confidence: price.confidence,
      source: 'defillama',
      observedTimestamp: price.timestamp,
      observationEndpoint: '/prices/current',
      updatedAt
    })
  }
  await insertProvisionalTokenPrices(pool, writes)

  const merged = rows.map(
    (row) => (row.timestamp === todayEnd && fresh.get(currentPriceKey(row.chain, row.token))) || row
  )
  for (const [key, record] of fresh) {
    if (!todayRows.has(key)) merged.push(record)
  }
  return merged
}
