import type { Pool } from '@neondatabase/serverless'
import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS } from '../../clients/defillama'
import { insertTokenPrices } from '../../db'
import { ensure } from '../../http'
import type { BatchHistoricalResponseCoin, ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '../../types'
import {
  currentUtcDayEnd,
  normalizedDaysInRange,
  normalizeToEndOfDay,
  parseTokenKey,
  toFetchTimestamp
} from '../../utils'

export interface ResolvedPriceRecord extends ExactPriceRecord {
  /** Timestamp of the underlying observation, not of the day it is keyed under. */
  observedAt: number
}

/**
 * DeFiLlama answers with the nearest observation it has, ignoring searchWidth
 * for some markets: a thin token's "price" can be days from the requested day.
 * The warmup writer bounds those to searchWidth, and a request-path row that
 * skipped the bound would freeze an out-of-window observation as that day's
 * permanent close. A derived on-chain path inherits the observation timestamp of
 * the market leaf it prices against, so it carries the same drift and is bounded
 * too — except for a chainlink leaf, which reports the requested time instead of
 * its heartbeat age (src/registries/market-price.ts). Chainlink resolved directly
 * is exempt here for the same reason: its observation is the feed's own updatedAt
 * at the resolved block, which a heartbeat feed leaves stale between updates by
 * design.
 */
function isWithinObservationWindow(record: ResolvedPriceRecord): boolean {
  if (record.source === 'chainlink') {
    return true
  }
  return Math.abs(record.observedAt - toFetchTimestamp(record.timestamp)) <= DEFI_LLAMA_SEARCH_WIDTH_SECONDS
}

function isPersistableDay(timestamp: number): boolean {
  return normalizeToEndOfDay(timestamp) <= currentUtcDayEnd()
}

/**
 * Best-effort request-path persistence. Closed past days and the current UTC
 * day are written (today as a mutable row) so a DeFiLlama fill is a table hit
 * for the rest of the day and does not 429-stampede. Future-day keys are not
 * written. A write failure is logged and swallowed — the response already
 * holds the prices, and a persistence fault must not turn a serveable 200 into
 * a 500.
 */
export async function persistResolvedPrices(pool: Pool, records: ResolvedPriceRecord[]): Promise<number> {
  const rows = records.filter((record) => isPersistableDay(record.timestamp) && isWithinObservationWindow(record))
  if (rows.length === 0) {
    return 0
  }
  try {
    await insertTokenPrices(pool, rows)
    return rows.length
  } catch (error) {
    console.warn(
      JSON.stringify({
        message: 'persist-resolved-failed',
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error)
      })
    )
    return 0
  }
}

export function buildTokenKey(chain: string, token: string): string {
  return `${chain}:${token}`
}

export function buildOriginalKeyMap(raw: string): Map<string, string> {
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

export function groupRowsByToken(
  rows: ExactPriceRecord[],
  originalKeyMap: Map<string, string>
): Map<string, BatchHistoricalResponseCoin> {
  const coins = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const normalizedKey = buildTokenKey(row.chain, row.token)
    const tokenKey = originalKeyMap.get(normalizedKey) ?? normalizedKey
    const current = coins.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source
    })
    if (!current.symbol && row.symbol) {
      current.symbol = row.symbol
    }
    coins.set(tokenKey, current)
  }

  for (const coin of coins.values()) {
    coin.prices.sort((left, right) => left.timestamp - right.timestamp)
  }

  return coins
}

export function toExactKey(entry: HistoricalRequestTuple | RangeRequest | ExactPriceRecord): string {
  if ('timestamp' in entry) {
    return `${entry.chain}:${entry.token}:${entry.timestamp}`
  }

  const timestamps = normalizedDaysInRange(entry.startTimestamp, entry.endTimestamp)
  ensure(timestamps.length > 0, 'INTERNAL_ERROR', 'Unexpected empty range')
  return `${entry.chain}:${entry.token}:${timestamps[0]}`
}
