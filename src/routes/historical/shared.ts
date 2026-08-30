import type { Pool } from '@neondatabase/serverless'
import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS } from '../../clients/defillama'
import { insertTokenPrices } from '../../db'
import { ensure } from '../../http'
import type { BatchHistoricalResponseCoin, ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '../../types'
import { isClosedDay, normalizedDaysInRange, parseTokenKey } from '../../utils'

export interface ResolvedPriceRecord extends ExactPriceRecord {
  /** Timestamp of the underlying observation, not of the day it is keyed under. */
  observedAt: number
}

/**
 * DeFiLlama answers with the nearest observation it has, ignoring searchWidth
 * for some markets: a thin token's "price" can be days from the requested day.
 * The warmup writer bounds those to searchWidth, and a request-path row that
 * skipped the bound would freeze an out-of-window observation as that day's
 * permanent close. Sources whose observation is the resolved block's own state
 * (chainlink, on-chain) are in-window by construction and are not bounded here.
 */
function isWithinObservationWindow(record: ResolvedPriceRecord): boolean {
  if (!record.source.startsWith('defillama')) {
    return true
  }
  return Math.abs(record.observedAt - record.timestamp) <= DEFI_LLAMA_SEARCH_WIDTH_SECONDS
}

/**
 * Best-effort request-path persistence. Only closed past days are written:
 * a current- or future-day key was resolved at "now", and writing it under the
 * day-end key would freeze that intraday value as the day's permanent close
 * once the row turns immutable at midnight (the invariant src/routes/spot.ts
 * documents). A write failure is logged and swallowed — the response already
 * holds the prices, and a persistence fault must not turn a serveable 200 into
 * a 500.
 */
export async function persistResolvedPrices(pool: Pool, records: ResolvedPriceRecord[]): Promise<number> {
  const rows = records.filter((record) => isClosedDay(record.timestamp) && isWithinObservationWindow(record))
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
