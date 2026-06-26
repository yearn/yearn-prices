import { describe, expect, it } from 'vitest'
import { capConfidence, isPlausiblePrice, MAX_PLAUSIBLE_PRICE } from '../src/format'

describe('isPlausiblePrice', () => {
  it('accepts prices in (0, MAX]', () => {
    expect(isPlausiblePrice(1)).toBe(true)
    expect(isPlausiblePrice(0.0001)).toBe(true)
    expect(isPlausiblePrice(MAX_PLAUSIBLE_PRICE)).toBe(true)
  })

  it('rejects provider garbage', () => {
    expect(isPlausiblePrice(0)).toBe(false)
    expect(isPlausiblePrice(-1)).toBe(false)
    expect(isPlausiblePrice(MAX_PLAUSIBLE_PRICE + 1)).toBe(false)
    expect(isPlausiblePrice(1e10)).toBe(false)
    expect(isPlausiblePrice(Number.NaN)).toBe(false)
    expect(isPlausiblePrice(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('capConfidence', () => {
  it('clamps to [0, 1]', () => {
    expect(capConfidence(1.01)).toBe(1)
    expect(capConfidence(-0.5)).toBe(0)
    expect(capConfidence(0.7)).toBe(0.7)
  })

  it('passes through null/undefined as null', () => {
    expect(capConfidence(null)).toBeNull()
    expect(capConfidence(undefined)).toBeNull()
  })
})
