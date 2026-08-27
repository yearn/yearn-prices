import { describe, expect, it } from 'vitest'
import { isTodayNormalized, normalizeToEndOfDay, toFetchTimestamp } from '../src/utils/time'

const DAY = 86_400
const NOW = 1_787_911_200
const DAY_START = NOW - (NOW % DAY)
const DAY_END = DAY_START + DAY - 1

describe('normalizeToEndOfDay', () => {
  it('snaps any timestamp in a day to that day 23:59:59', () => {
    expect(normalizeToEndOfDay(DAY_START)).toBe(DAY_END)
    expect(normalizeToEndOfDay(NOW)).toBe(DAY_END)
    expect(normalizeToEndOfDay(DAY_END)).toBe(DAY_END)
  })

  it('keeps adjacent days apart', () => {
    expect(normalizeToEndOfDay(DAY_START - 1)).toBe(DAY_START - 1)
    expect(normalizeToEndOfDay(DAY_START + DAY)).toBe(DAY_END + DAY)
  })
})

describe('isTodayNormalized', () => {
  it('matches any timestamp from the current utc day', () => {
    expect(isTodayNormalized(DAY_START, NOW)).toBe(true)
    expect(isTodayNormalized(NOW - 600, NOW)).toBe(true)
    expect(isTodayNormalized(DAY_END, NOW)).toBe(true)
  })

  it('rejects other days', () => {
    expect(isTodayNormalized(DAY_START - 1, NOW)).toBe(false)
    expect(isTodayNormalized(NOW - DAY, NOW)).toBe(false)
    expect(isTodayNormalized(NOW + DAY, NOW)).toBe(false)
  })
})

describe('toFetchTimestamp', () => {
  it('clamps current-day timestamps to now', () => {
    expect(toFetchTimestamp(NOW - 600, NOW)).toBe(NOW)
    expect(toFetchTimestamp(DAY_START, NOW)).toBe(NOW)
    expect(toFetchTimestamp(DAY_END, NOW)).toBe(NOW)
  })

  it('clamps right after utc midnight, when end-of-day is ~24h in the future', () => {
    const now = DAY_START + 300
    expect(toFetchTimestamp(DAY_START + 60, now)).toBe(now)
    expect(toFetchTimestamp(normalizeToEndOfDay(now), now)).toBe(now)
  })

  it('never clamps past days', () => {
    expect(toFetchTimestamp(NOW - DAY, NOW)).toBe(NOW - DAY)
    expect(toFetchTimestamp(DAY_START - 1, NOW)).toBe(DAY_START - 1)
    expect(toFetchTimestamp(normalizeToEndOfDay(NOW - DAY), NOW)).toBe(normalizeToEndOfDay(NOW - DAY))
  })
})
