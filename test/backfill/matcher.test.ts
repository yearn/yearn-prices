import { describe, expect, it } from 'vitest'
import { MAXIMUM_ACCEPTED_OFFSET_SECONDS } from '../../src/backfill/constants'
import { matchChartObservation } from '../../src/backfill/matcher'

const EOD = 1_704_153_599

function coin(offsets: Array<[number, number]>, extra: Record<string, unknown> = {}) {
  return {
    symbol: 'WETH',
    confidence: 0.99,
    prices: offsets.map(([offset, price]) => ({ timestamp: EOD + offset, price })),
    ...extra
  }
}

describe('the closest-observation matcher', () => {
  it('selects a single pre-EOD observation', () => {
    expect(matchChartObservation(coin([[-30, 1000]]), EOD)).toMatchObject({
      kind: 'matched',
      price: 1000,
      symbol: 'WETH',
      confidence: 0.99,
      observedTimestamp: EOD - 30,
      offsetSeconds: -30
    })
  })

  it('selects a single post-EOD observation', () => {
    expect(matchChartObservation(coin([[15, 1001]]), EOD)).toMatchObject({
      kind: 'matched',
      observedTimestamp: EOD + 15,
      offsetSeconds: 15
    })
  })

  it('selects the closer post-EOD observation over a farther pre-EOD one', () => {
    expect(
      matchChartObservation(
        coin([
          [-30, 1000],
          [15, 1001]
        ]),
        EOD
      )
    ).toMatchObject({ kind: 'matched', price: 1001, offsetSeconds: 15 })
  })

  it('prefers the pre-EOD observation on an equal-distance tie', () => {
    expect(
      matchChartObservation(
        coin([
          [-15, 1000],
          [15, 1001]
        ]),
        EOD
      )
    ).toMatchObject({ kind: 'matched', price: 1000, offsetSeconds: -15 })
  })

  it('treats the window as inclusive and breaks the boundary tie pre-EOD', () => {
    const result = matchChartObservation(
      coin([
        [-MAXIMUM_ACCEPTED_OFFSET_SECONDS, 900],
        [MAXIMUM_ACCEPTED_OFFSET_SECONDS, 1100]
      ]),
      EOD
    )
    expect(result).toMatchObject({ kind: 'matched', price: 900, offsetSeconds: -MAXIMUM_ACCEPTED_OFFSET_SECONDS })
  })

  it('ignores observations outside the window', () => {
    expect(
      matchChartObservation(
        coin([
          [-MAXIMUM_ACCEPTED_OFFSET_SECONDS - 1, 900],
          [MAXIMUM_ACCEPTED_OFFSET_SECONDS + 1, 1100]
        ]),
        EOD
      )
    ).toEqual({ kind: 'not_found' })
  })

  it('collapses identical duplicate observations', () => {
    expect(
      matchChartObservation(
        coin([
          [-30, 1000],
          [-30, 1000]
        ]),
        EOD
      )
    ).toMatchObject({ kind: 'matched', price: 1000, observedTimestamp: EOD - 30 })
  })

  it('reports conflicting prices at one timestamp as an invalid response', () => {
    expect(
      matchChartObservation(
        coin([
          [-30, 1000],
          [-30, 1002]
        ]),
        EOD
      )
    ).toEqual({ kind: 'invalid_response' })
  })

  it('ignores a conflict outside the window', () => {
    const outside = MAXIMUM_ACCEPTED_OFFSET_SECONDS + 60
    expect(
      matchChartObservation(
        coin([
          [-30, 1000],
          [outside, 1],
          [outside, 2]
        ]),
        EOD
      )
    ).toMatchObject({ kind: 'matched', price: 1000 })
  })

  it('rejects malformed observations without failing the response', () => {
    const entry = {
      prices: [
        { timestamp: EOD - 10, price: 0 },
        { timestamp: EOD - 11, price: -1 },
        { timestamp: EOD - 12, price: Number.POSITIVE_INFINITY },
        { timestamp: EOD - 13, price: Number.NaN },
        { timestamp: EOD - 14, price: '1000' },
        { timestamp: EOD - 15 },
        { timestamp: -1, price: 1000 },
        { timestamp: EOD + 0.5, price: 1000 },
        null,
        { timestamp: EOD - 40, price: 999 }
      ]
    }
    expect(matchChartObservation(entry, EOD)).toMatchObject({ kind: 'matched', price: 999, offsetSeconds: -40 })
  })

  it('returns not_found for a missing coin entry and for an empty price list', () => {
    expect(matchChartObservation(undefined, EOD)).toEqual({ kind: 'not_found' })
    expect(matchChartObservation(coin([]), EOD)).toEqual({ kind: 'not_found' })
  })

  it('returns invalid_response for a broken response shape', () => {
    expect(matchChartObservation({ prices: 'nope' }, EOD)).toEqual({ kind: 'invalid_response' })
    expect(matchChartObservation(coin([[-30, 1000]], { symbol: 'x'.repeat(65) }), EOD)).toEqual({
      kind: 'invalid_response'
    })
    expect(matchChartObservation(coin([[-30, 1000]], { confidence: Number.NaN }), EOD)).toEqual({
      kind: 'invalid_response'
    })
  })

  it('accepts an absent symbol and a null confidence', () => {
    expect(matchChartObservation({ confidence: null, prices: [{ timestamp: EOD, price: 5 }] }, EOD)).toMatchObject({
      kind: 'matched',
      symbol: null,
      confidence: null,
      offsetSeconds: 0
    })
  })

  it('falls back to the next eligible observation when the predicate rejects the nearest', () => {
    const result = matchChartObservation(
      coin([
        [60, 1100],
        [-120, 1000]
      ]),
      EOD,
      { isEligibleObservation: (timestamp) => timestamp <= EOD }
    )
    expect(result).toMatchObject({ kind: 'matched', price: 1000, offsetSeconds: -120 })
  })

  it('returns not_found when the predicate rejects every observation', () => {
    expect(matchChartObservation(coin([[60, 1100]]), EOD, { isEligibleObservation: () => false })).toEqual({
      kind: 'not_found'
    })
  })

  it('honors a narrower window than the default', () => {
    expect(matchChartObservation(coin([[-3_600, 1000]]), EOD, { maximumOffsetSeconds: 600 })).toEqual({
      kind: 'not_found'
    })
  })
})
