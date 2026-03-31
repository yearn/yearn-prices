import { parseTokenKey } from './chains'
import { ApiError, ensure } from './errors'
import { normalizeToEndOfDay, normalizedRangeDayCount } from './time'
import { SOURCE_PRIORITY, type HistoricalRequestTuple, type PriceSource, type RangeRequest } from './types'

const MAX_BATCH_TOKENS = 50
const MAX_BATCH_TIMESTAMPS_PER_TOKEN = 90
const MAX_RANGE_TOKENS = 50
const MAX_RANGE_DAYS = 366

export function parseTimestampSegment(segment: string): number {
  ensure(/^\d+$/.test(segment), 'INVALID_INPUT', 'Timestamp must be a unix timestamp')
  return normalizeToEndOfDay(Number(segment))
}

export function parseOptionalSource(value: string | null): PriceSource | undefined {
  if (!value) {
    return undefined
  }

  if (!SOURCE_PRIORITY.includes(value as PriceSource)) {
    throw new ApiError('INVALID_INPUT', `Unsupported source: ${value}`)
  }

  return value as PriceSource
}

export function parseBatchCoins(raw: string | null): HistoricalRequestTuple[] {
  ensure(raw, 'INVALID_INPUT', 'Missing coins query parameter')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Invalid coins query parameter')
  }

  ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_INPUT', 'Coins payload must be an object')
  const entries = Object.entries(parsed)
  ensure(entries.length <= MAX_BATCH_TOKENS, 'INVALID_INPUT', `A maximum of ${MAX_BATCH_TOKENS} tokens is allowed`)

  const requests: HistoricalRequestTuple[] = []
  for (const [tokenKey, timestamps] of entries) {
    ensure(Array.isArray(timestamps), 'INVALID_INPUT', `Batch timestamps for ${tokenKey} must be an array`)
    ensure(timestamps.length <= MAX_BATCH_TIMESTAMPS_PER_TOKEN, 'INVALID_INPUT', `A maximum of ${MAX_BATCH_TIMESTAMPS_PER_TOKEN} timestamps is allowed per token`)

    const parsedTokenKey = parseTokenKey(tokenKey)
    const dedupedTimestamps = new Set<number>()
    for (const timestamp of timestamps) {
      ensure(typeof timestamp === 'number' || /^\d+$/.test(String(timestamp)), 'INVALID_INPUT', `Invalid timestamp for ${tokenKey}`)
      dedupedTimestamps.add(normalizeToEndOfDay(Number(timestamp)))
    }

    for (const normalizedTimestamp of dedupedTimestamps) {
      requests.push({
        chain: parsedTokenKey.chain,
        token: parsedTokenKey.token,
        timestamp: normalizedTimestamp,
      })
    }
  }

  return requests
}

export function parseRangeCoins(raw: string | null): RangeRequest[] {
  ensure(raw, 'INVALID_INPUT', 'Missing coins query parameter')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Invalid coins query parameter')
  }

  ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_INPUT', 'Coins payload must be an object')
  const entries = Object.entries(parsed)
  ensure(entries.length <= MAX_RANGE_TOKENS, 'INVALID_INPUT', `A maximum of ${MAX_RANGE_TOKENS} tokens is allowed`)

  return entries.map(([tokenKey, range]) => {
    ensure(Array.isArray(range) && range.length === 2, 'INVALID_INPUT', `Range for ${tokenKey} must be [start, end]`)
    const [startRaw, endRaw] = range
    ensure(typeof startRaw === 'number' || /^\d+$/.test(String(startRaw)), 'INVALID_INPUT', `Invalid start timestamp for ${tokenKey}`)
    ensure(typeof endRaw === 'number' || /^\d+$/.test(String(endRaw)), 'INVALID_INPUT', `Invalid end timestamp for ${tokenKey}`)

    const startTimestamp = normalizeToEndOfDay(Number(startRaw))
    const endTimestamp = normalizeToEndOfDay(Number(endRaw))
    ensure(startTimestamp <= endTimestamp, 'INVALID_INPUT', `Range start must be <= end for ${tokenKey}`)
    ensure(
      normalizedRangeDayCount(startTimestamp, endTimestamp) <= MAX_RANGE_DAYS,
      'INVALID_INPUT',
      `A maximum of ${MAX_RANGE_DAYS} days is allowed per token range`,
    )

    const parsedTokenKey = parseTokenKey(tokenKey)
    return {
      chain: parsedTokenKey.chain,
      token: parsedTokenKey.token,
      startTimestamp,
      endTimestamp,
    }
  })
}
