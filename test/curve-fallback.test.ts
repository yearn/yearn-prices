import { describe, expect, it } from 'vitest'
import { shouldAttemptCurveFallback } from '../src/curve-fallback'
import { normalizeToEndOfDay } from '../src/time'

const CHAIN = 'ethereum'
const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DENYLISTED = '0xdF5e0e81Dff6FAF3A7e52BA697820c5e32D806A8'

// Fixed "now" so today's end-of-day is deterministic in tests.
const NOW = 1_700_000_000 // 2023-11-14T22:13:20Z
const TODAY = normalizeToEndOfDay(NOW)
const YESTERDAY = TODAY - 86_400
const LAST_WEEK = TODAY - 7 * 86_400

function key(token: string, timestamp: number): string {
  return `${CHAIN}:${token}:${timestamp}`
}

function request(token: string, timestamp: number) {
  return { chain: CHAIN, token, timestamp }
}

describe('shouldAttemptCurveFallback', () => {
  it('skips historical days that already have a valid DefiLlama row', () => {
    const existingDefillama = new Set([key(TOKEN, YESTERDAY)])
    const existingCurve = new Set<string>()

    expect(
      shouldAttemptCurveFallback(request(TOKEN, YESTERDAY), existingDefillama, existingCurve, NOW),
    ).toBe(false)
  })

  it('probes when DefiLlama is absent (including denylisted rows filtered out of the set)', () => {
    // getExistingExactTimestamps(..., 'defillama') excludes denylisted LPs, so the
    // key never appears here even if a garbage DefiLlama row is stored.
    const existingDefillama = new Set<string>()
    const existingCurve = new Set<string>()

    expect(
      shouldAttemptCurveFallback(request(DENYLISTED, YESTERDAY), existingDefillama, existingCurve, NOW),
    ).toBe(true)
    expect(
      shouldAttemptCurveFallback(request(TOKEN, LAST_WEEK), existingDefillama, existingCurve, NOW),
    ).toBe(true)
  })

  it('skips historical days that already have a Curve row', () => {
    const existingDefillama = new Set<string>()
    const existingCurve = new Set([key(DENYLISTED, YESTERDAY)])

    expect(
      shouldAttemptCurveFallback(request(DENYLISTED, YESTERDAY), existingDefillama, existingCurve, NOW),
    ).toBe(false)
  })

  it('skips when both DefiLlama and Curve already exist', () => {
    const existingDefillama = new Set([key(TOKEN, YESTERDAY)])
    const existingCurve = new Set([key(TOKEN, YESTERDAY)])

    expect(
      shouldAttemptCurveFallback(request(TOKEN, YESTERDAY), existingDefillama, existingCurve, NOW),
    ).toBe(false)
  })

  it('always refreshes today even when both sources already have a row', () => {
    const existingDefillama = new Set([key(TOKEN, TODAY)])
    const existingCurve = new Set([key(TOKEN, TODAY), key(DENYLISTED, TODAY)])

    expect(
      shouldAttemptCurveFallback(request(TOKEN, TODAY), existingDefillama, existingCurve, NOW),
    ).toBe(true)
    expect(
      shouldAttemptCurveFallback(request(DENYLISTED, TODAY), existingDefillama, existingCurve, NOW),
    ).toBe(true)
  })
})
