import { describe, expect, it } from 'vitest'
import { yearnShareAdapter } from '../../../src/sources/onchain/adapters/yearn-share'
import { adapterOptions, priceWith } from './helpers'

const VAULT = '0x1111111111111111111111111111111111111111'
const UNDERLYING = '0x2222222222222222222222222222222222222222'

describe('yearnShareAdapter', () => {
  it('prices a v2 vault from pricePerShare', async () => {
    const options = adapterOptions({
      [VAULT]: { token: UNDERLYING, pricePerShare: 1_500_000n, decimals: 6 },
      [UNDERLYING]: { decimals: 6 }
    })

    const result = await priceWith(yearnShareAdapter(options), { [UNDERLYING]: 2 }, VAULT)

    expect(result.path?.priceUsd).toBeCloseTo(3)
    expect(result.path?.metadata.method).toBe('pricePerShare')
  })

  it('scales pricePerShare by vault decimals, not underlying decimals', async () => {
    const options = adapterOptions({
      [VAULT]: { token: UNDERLYING, pricePerShare: 15n * 10n ** 17n, decimals: 18 },
      [UNDERLYING]: { decimals: 6 }
    })

    const result = await priceWith(yearnShareAdapter(options), { [UNDERLYING]: 2 }, VAULT)

    expect(result.path?.priceUsd).toBeCloseTo(3)
    expect(result.path?.metadata.rateDecimals).toBe(18)
  })

  it('treats getPricePerFullShare as an 18-decimal rate', async () => {
    const options = adapterOptions({
      [VAULT]: { want: UNDERLYING, getPricePerFullShare: 2n * 10n ** 18n, decimals: 6 },
      [UNDERLYING]: { decimals: 6 }
    })

    const result = await priceWith(yearnShareAdapter(options), { [UNDERLYING]: 1 }, VAULT)

    expect(result.path?.priceUsd).toBeCloseTo(2)
    expect(result.path?.metadata.rateDecimals).toBe(18)
  })

  it('returns no price when no rate method exists', async () => {
    const options = adapterOptions({
      [VAULT]: { token: UNDERLYING, decimals: 6 },
      [UNDERLYING]: { decimals: 6 }
    })

    const result = await priceWith(yearnShareAdapter(options), { [UNDERLYING]: 2 }, VAULT)

    expect(result.path).toBeNull()
  })
})
