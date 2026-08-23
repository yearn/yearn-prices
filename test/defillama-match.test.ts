import { describe, expect, it } from 'vitest'
import { matchPricesToRequests } from '../src/sources/defillama/match'

const D16 = 1_755_388_799 // 2025-08-16 23:59:59Z
const D17 = D16 + 86_400
const D18 = D17 + 86_400

describe('matchPricesToRequests', () => {
  it('maps a sample just past midnight to the requested day, not the next one', () => {
    const matched = matchPricesToRequests(
      [D16, D17],
      [
        { timestamp: D16 + 2, price: 5649.51 },
        { timestamp: D17 - 10, price: 5680.28 }
      ]
    )

    expect(matched.get(D16)?.price).toBe(5649.51)
    expect(matched.get(D17)?.price).toBe(5680.28)
  })

  it('leaves a request unmatched when no sample is within the search width', () => {
    const matched = matchPricesToRequests([D16, D18], [{ timestamp: D16 + 5, price: 1 }])

    expect(matched.get(D16)?.price).toBe(1)
    expect(matched.has(D18)).toBe(false)
  })

  it('ignores samples further away than the search width', () => {
    const matched = matchPricesToRequests([D16], [{ timestamp: D16 + 7 * 3600, price: 1 }])

    expect(matched.size).toBe(0)
  })

  it('never assigns one sample to two requests', () => {
    const matched = matchPricesToRequests([D16, D16 + 3600], [{ timestamp: D16 + 1, price: 7 }])

    expect(matched.get(D16)?.price).toBe(7)
    expect(matched.has(D16 + 3600)).toBe(false)
  })

  it('gives each sample to its nearest request when both are in range', () => {
    const matched = matchPricesToRequests(
      [D16, D16 + 3600],
      [
        { timestamp: D16 + 3595, price: 9 },
        { timestamp: D16 + 3, price: 8 }
      ]
    )

    expect(matched.get(D16)?.price).toBe(8)
    expect(matched.get(D16 + 3600)?.price).toBe(9)
  })

  it('skips samples with a non-finite price', () => {
    const matched = matchPricesToRequests([D16], [{ timestamp: D16 + 1, price: Number.NaN }])

    expect(matched.size).toBe(0)
  })

  it('falls back to a sample within the upstream six-hour fetch width', () => {
    const matched = matchPricesToRequests([D16], [{ timestamp: D16 + 2 * 3600, price: 1 }])

    expect(matched.get(D16)?.price).toBe(1)
  })

  it('falls back to a same-UTC-day sample hours before end-of-day', () => {
    const matched = matchPricesToRequests([D16], [{ timestamp: D16 - 3 * 3600, price: 42 }])

    expect(matched.get(D16)?.price).toBe(42)
  })

  it('prefers the near-midnight cross-day sample for the prior day over the same-day fallback', () => {
    const matched = matchPricesToRequests(
      [D16, D17],
      [
        { timestamp: D16 + 5, price: 1 }, // ~5s past D16 EOD -> D17 by day, but nearest to D16 request
        { timestamp: D17 - 3 * 3600, price: 2 } // same-day D17 fallback
      ]
    )

    expect(matched.get(D16)?.price).toBe(1)
    expect(matched.get(D17)?.price).toBe(2)
  })

  it('is order independent and picks the nearest sample', () => {
    const matched = matchPricesToRequests(
      [D17],
      [
        { timestamp: D17 + 3600, price: 2 },
        { timestamp: D17 - 5, price: 3 }
      ]
    )

    expect(matched.get(D17)?.price).toBe(3)
  })
})
