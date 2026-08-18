import { describe, expect, it } from 'vitest'
import { compoundAdapter } from '../../../src/sources/onchain/adapters/compound'
import { adapterOptions, priceWith } from './helpers'

const CTOKEN = '0x1111111111111111111111111111111111111111'
const UNDERLYING = '0x3333333333333333333333333333333333333333'

describe('compoundAdapter', () => {
  it('prices a cToken from its stored exchange rate', async () => {
    const options = adapterOptions({
      [CTOKEN]: { underlying: UNDERLYING, exchangeRateStored: 2n * 10n ** 26n, decimals: 8 },
      [UNDERLYING]: { decimals: 18 }
    })

    const result = await priceWith(compoundAdapter(options), { [UNDERLYING]: 1 }, CTOKEN)

    expect(result.path?.priceUsd).toBeCloseTo(0.02)
  })

  it('returns no price without the Compound interface', async () => {
    const options = adapterOptions({ [CTOKEN]: { decimals: 8 } })

    const result = await priceWith(compoundAdapter(options), { [UNDERLYING]: 1 }, CTOKEN)

    expect(result.path).toBeNull()
  })
})
