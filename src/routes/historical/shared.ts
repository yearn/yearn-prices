import { ensure } from '../../http'
import type { BatchHistoricalResponseCoin, ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '../../types'
import { normalizedDaysInRange, normalizeToEndOfDay, parseTokenKey } from '../../utils'

export function buildTokenKey(chain: string, token: string): string {
  return `${chain}:${token}`
}

export type OriginalKeyBinding = {
  originalKey: string
  timestamps: Set<number>
}

function requestedTimestamps(value: unknown, kind: 'batch' | 'range'): Set<number> {
  if (!Array.isArray(value)) {
    return new Set()
  }
  if (kind === 'range') {
    if (value.length !== 2) {
      return new Set()
    }
    return new Set(normalizedDaysInRange(normalizeToEndOfDay(Number(value[0])), normalizeToEndOfDay(Number(value[1]))))
  }
  const timestamps = new Set<number>()
  for (const timestamp of value) {
    timestamps.add(normalizeToEndOfDay(Number(timestamp)))
  }
  return timestamps
}

export function buildOriginalKeyMap(raw: string, kind: 'batch' | 'range'): Map<string, OriginalKeyBinding[]> {
  const map = new Map<string, OriginalKeyBinding[]>()
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const originalKey of Object.keys(parsed)) {
      try {
        const { chain, token } = parseTokenKey(originalKey)
        const normalizedKey = buildTokenKey(chain, token)
        const binding = { originalKey, timestamps: requestedTimestamps(parsed[originalKey], kind) }
        const existing = map.get(normalizedKey)
        if (existing) {
          existing.push(binding)
        } else {
          map.set(normalizedKey, [binding])
        }
      } catch {}
    }
  } catch {}
  return map
}

export function groupRowsByToken(
  rows: ExactPriceRecord[],
  originalKeyMap: Map<string, OriginalKeyBinding[]>
): Map<string, BatchHistoricalResponseCoin> {
  const coins = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const normalizedKey = buildTokenKey(row.chain, row.token)
    const bindings = originalKeyMap.get(normalizedKey) ?? [
      { originalKey: normalizedKey, timestamps: new Set([row.timestamp]) }
    ]
    for (const binding of bindings) {
      if (!binding.timestamps.has(row.timestamp)) {
        continue
      }
      const current = coins.get(binding.originalKey) ?? { symbol: row.symbol, prices: [] }
      current.prices.push({
        timestamp: row.timestamp,
        price: row.price,
        confidence: row.confidence,
        source: row.source
      })
      if (!current.symbol && row.symbol) {
        current.symbol = row.symbol
      }
      coins.set(binding.originalKey, current)
    }
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
