import { ApiError, ensure } from '../http/errors'
import type { HistoricalRequestTuple, PriceSource, RangeRequest, SpotRequest } from '../types'
import { SOURCE_PRIORITY } from '../types'
import { parseTokenKey } from './chains'
import { normalizedRangeDayCount, normalizeToEndOfDay } from './time'

const MAX_BATCH_TOKENS = 50
const MAX_BATCH_TIMESTAMPS_PER_TOKEN = 90
const MAX_RANGE_TOKENS = 50
const MAX_RANGE_DAYS = 366
const MAX_SPOT_TOKENS = 50

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

export function parseSpotCoins(raw: string | null): SpotRequest[] {
  ensure(raw, 'INVALID_INPUT', 'Missing coins query parameter')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Invalid coins query parameter')
  }

  ensure(Array.isArray(parsed), 'INVALID_INPUT', 'Coins payload must be an array of token keys')
  ensure(parsed.length > 0, 'INVALID_INPUT', 'Coins payload must not be empty')
  ensure(parsed.length <= MAX_SPOT_TOKENS, 'INVALID_INPUT', `A maximum of ${MAX_SPOT_TOKENS} tokens is allowed`)

  const seen = new Set<string>()
  const requests: SpotRequest[] = []
  for (const entry of parsed) {
    ensure(typeof entry === 'string', 'INVALID_INPUT', 'Each coin must be a "<chain>:<address>" string')

    let parsedKey
    try {
      parsedKey = parseTokenKey(entry)
    } catch (error) {
      throw new ApiError('INVALID_INPUT', error instanceof Error ? error.message : `Invalid token key: ${entry}`)
    }

    if (seen.has(parsedKey.tokenKey)) {
      continue
    }
    seen.add(parsedKey.tokenKey)
    requests.push({ chain: parsedKey.chain, token: parsedKey.token, originalKey: entry })
  }

  return requests
}

export function parseBatchCoins(raw: string | null): HistoricalRequestTuple[] {
  ensure(raw, 'INVALID_INPUT', 'Missing coins query parameter')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Invalid coins query parameter')
  }

  ensure(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'INVALID_INPUT',
    'Coins payload must be an object'
  )
  const entries = Object.entries(parsed)
  ensure(entries.length <= MAX_BATCH_TOKENS, 'INVALID_INPUT', `A maximum of ${MAX_BATCH_TOKENS} tokens is allowed`)

  const requests: HistoricalRequestTuple[] = []
  for (const [tokenKey, timestamps] of entries) {
    ensure(Array.isArray(timestamps), 'INVALID_INPUT', `Batch timestamps for ${tokenKey} must be an array`)
    ensure(
      timestamps.length <= MAX_BATCH_TIMESTAMPS_PER_TOKEN,
      'INVALID_INPUT',
      `A maximum of ${MAX_BATCH_TIMESTAMPS_PER_TOKEN} timestamps is allowed per token`
    )

    const parsedTokenKey = parseTokenKey(tokenKey)
    const dedupedTimestamps = new Set<number>()
    for (const timestamp of timestamps) {
      ensure(
        typeof timestamp === 'number' || /^\d+$/.test(String(timestamp)),
        'INVALID_INPUT',
        `Invalid timestamp for ${tokenKey}`
      )
      dedupedTimestamps.add(normalizeToEndOfDay(Number(timestamp)))
    }

    for (const normalizedTimestamp of dedupedTimestamps) {
      requests.push({
        chain: parsedTokenKey.chain,
        token: parsedTokenKey.token,
        timestamp: normalizedTimestamp
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

  ensure(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'INVALID_INPUT',
    'Coins payload must be an object'
  )
  const entries = Object.entries(parsed)
  ensure(entries.length <= MAX_RANGE_TOKENS, 'INVALID_INPUT', `A maximum of ${MAX_RANGE_TOKENS} tokens is allowed`)

  return entries.map(([tokenKey, range]) => {
    ensure(Array.isArray(range) && range.length === 2, 'INVALID_INPUT', `Range for ${tokenKey} must be [start, end]`)
    const [startRaw, endRaw] = range
    ensure(
      typeof startRaw === 'number' || /^\d+$/.test(String(startRaw)),
      'INVALID_INPUT',
      `Invalid start timestamp for ${tokenKey}`
    )
    ensure(
      typeof endRaw === 'number' || /^\d+$/.test(String(endRaw)),
      'INVALID_INPUT',
      `Invalid end timestamp for ${tokenKey}`
    )

    const startTimestamp = normalizeToEndOfDay(Number(startRaw))
    const endTimestamp = normalizeToEndOfDay(Number(endRaw))
    ensure(startTimestamp <= endTimestamp, 'INVALID_INPUT', `Range start must be <= end for ${tokenKey}`)
    ensure(
      normalizedRangeDayCount(startTimestamp, endTimestamp) <= MAX_RANGE_DAYS,
      'INVALID_INPUT',
      `A maximum of ${MAX_RANGE_DAYS} days is allowed per token range`
    )

    const parsedTokenKey = parseTokenKey(tokenKey)
    return {
      chain: parsedTokenKey.chain,
      token: parsedTokenKey.token,
      startTimestamp,
      endTimestamp
    }
  })
}
