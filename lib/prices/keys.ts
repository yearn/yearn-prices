import { parseTokenKey } from '@/lib/chains'
import { ensure } from '@/lib/api/errors'
import { normalizedDaysInRange } from '@/lib/time'
import type { ExactPriceRecord, HistoricalRequestTuple, RangeRequest } from '@/lib/prices/types'

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
      } catch {
        // Ignore unparsable keys; validation of the request body happens separately.
      }
    }
  } catch {
    // Ignore invalid JSON; route handlers validate coins payloads.
  }
  return map
}

export function toExactKey(entry: HistoricalRequestTuple | RangeRequest | ExactPriceRecord): string {
  if ('timestamp' in entry) {
    return `${entry.chain}:${entry.token}:${entry.timestamp}`
  }

  const timestamps = normalizedDaysInRange(entry.startTimestamp, entry.endTimestamp)
  ensure(timestamps.length > 0, 'INTERNAL_ERROR', 'Unexpected empty range')
  return `${entry.chain}:${entry.token}:${timestamps[0]}`
}
