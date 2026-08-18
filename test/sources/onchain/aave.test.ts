import { describe, expect, it } from 'vitest'
import { aaveAdapter } from '../../../src/sources/onchain/adapters/aave'
import { adapterOptions, priceWith } from './helpers'

const ATOKEN = '0x2222222222222222222222222222222222222222'
const UNDERLYING = '0x3333333333333333333333333333333333333333'

describe('aaveAdapter', () => {
  it('prices an aToken at its underlying price', async () => {
    const options = adapterOptions({ [ATOKEN]: { UNDERLYING_ASSET_ADDRESS: UNDERLYING } })

    const result = await priceWith(aaveAdapter(options), { [UNDERLYING]: 1.01 }, ATOKEN)

    expect(result.path?.priceUsd).toBeCloseTo(1.01)
    expect(result.path?.metadata.method).toBe('one-to-one')
  })

  it('returns no price when the underlying is the token itself', async () => {
    const options = adapterOptions({ [ATOKEN]: { UNDERLYING_ASSET_ADDRESS: ATOKEN } })

    const result = await priceWith(aaveAdapter(options), { [ATOKEN]: 1 }, ATOKEN)

    expect(result.path).toBeNull()
  })
})
