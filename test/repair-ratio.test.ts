import { describe, expect, it } from 'vitest'
import { computeRepairRatios } from '../src/sources/defillama/repair-ratio'
import { currentUtcDayEnd, normalizeToEndOfDay } from '../src/utils'

const D16 = normalizeToEndOfDay(1_755_388_799) // 2025-08-16 23:59:59Z

describe('computeRepairRatios', () => {
  it('returns newPrice / oldPrice for a corrected historical day', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: 110 }], new Map([[D16, 100]]))

    expect(ratios).toEqual([{ timestamp: D16, ratio: 1.1 }])
  })

  it('emits nothing on a re-run once the stored price already equals the correction (no double-scale)', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: 110 }], new Map([[D16, 110]]))

    expect(ratios).toHaveLength(0)
  })

  it('skips a day with no stored price to divide by', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: 110 }], new Map())

    expect(ratios).toHaveLength(0)
  })

  it('skips today rows (only historical days are rescaled)', () => {
    const ratios = computeRepairRatios(
      [{ timestamp: currentUtcDayEnd(), price: 110 }],
      new Map([[currentUtcDayEnd(), 100]])
    )

    expect(ratios).toHaveLength(0)
  })

  it('skips a zero corrected price (a zero ratio would wipe every dependent derived price)', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: 0 }], new Map([[D16, 100]]))

    expect(ratios).toHaveLength(0)
  })

  it('skips a negative corrected price', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: -5 }], new Map([[D16, 100]]))

    expect(ratios).toHaveLength(0)
  })

  it('skips a non-finite corrected price', () => {
    const ratios = computeRepairRatios([{ timestamp: D16, price: Number.NaN }], new Map([[D16, 100]]))

    expect(ratios).toHaveLength(0)
  })
})
