import { describe, expect, it } from 'vitest'
import { InvalidPricingError } from '../../../src/sources/onchain/errors'
import {
  calculateCompoundTokenPrice,
  calculatePoolNavPrice,
  calculateWrapperPrice,
  scaledRaw,
} from '../../../src/sources/onchain/math'

describe('scaledRaw', () => {
  it('scales by decimals', () => {
    expect(scaledRaw(1_500_000n, 6)).toBe(1.5)
  })

  it('rejects out-of-range decimals', () => {
    expect(() => scaledRaw(1n, 256)).toThrow(InvalidPricingError)
  })
})

describe('calculateWrapperPrice', () => {
  it('multiplies the share rate by the underlying price', () => {
    expect(calculateWrapperPrice(1_100_000n, 6, 10n ** 18n, 18, 2)).toBeCloseTo(2.2)
  })

  it('handles mismatched share and underlying decimals', () => {
    expect(calculateWrapperPrice(2_000_000n, 6, 10n ** 8n, 8, 3)).toBeCloseTo(6)
  })

  it('rejects a zero rate', () => {
    expect(() => calculateWrapperPrice(0n, 6, 10n ** 18n, 18, 2)).toThrow(InvalidPricingError)
  })
})

describe('calculateCompoundTokenPrice', () => {
  it('applies the 18 + underlying - token exponent', () => {
    expect(calculateCompoundTokenPrice(2n * 10n ** 26n, 8, 18, 1)).toBeCloseTo(0.02)
  })

  it('rejects an impossible scale', () => {
    expect(() => calculateCompoundTokenPrice(1n, 200, 0, 1)).toThrow(InvalidPricingError)
  })
})

describe('calculatePoolNavPrice', () => {
  const assets = [
    { address: '0xa', balanceRaw: 100n * 10n ** 6n, decimals: 6, priceUsd: 1 },
    { address: '0xb', balanceRaw: 100n * 10n ** 18n, decimals: 18, priceUsd: 1 },
  ]

  it('divides NAV by circulating supply', () => {
    expect(calculatePoolNavPrice(assets, 100n * 10n ** 18n, 18)).toBeCloseTo(2)
  })

  it('excludes pre-minted pool tokens from supply', () => {
    expect(calculatePoolNavPrice(assets, 200n * 10n ** 18n, 18, 100n * 10n ** 18n)).toBeCloseTo(2)
  })

  it('rejects an empty basket', () => {
    expect(() => calculatePoolNavPrice([], 10n, 18)).toThrow(InvalidPricingError)
  })

  it('rejects a zero circulating supply', () => {
    expect(() => calculatePoolNavPrice(assets, 0n, 18)).toThrow(InvalidPricingError)
  })

  it('rejects an unpriced constituent', () => {
    expect(() =>
      calculatePoolNavPrice([{ ...assets[0], priceUsd: 0 }], 10n ** 18n, 18),
    ).toThrow(InvalidPricingError)
  })
})
