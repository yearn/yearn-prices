import { describe, expect, it } from 'vitest'
import { wstEthAdapter } from '../../../src/sources/onchain/adapters/wsteth'
import { adapterOptions, priceWith } from './helpers'

const WSTETH = '0x4444444444444444444444444444444444444444'
const STETH = '0x5555555555555555555555555555555555555555'

describe('wstEthAdapter', () => {
  it('prices wstETH from stEthPerToken', async () => {
    const options = adapterOptions({
      [WSTETH]: { stETH: STETH, stEthPerToken: 1_200_000_000_000_000_000n },
    })

    const result = await priceWith(wstEthAdapter(options), { [STETH]: 2000 }, WSTETH)

    expect(result.path?.priceUsd).toBeCloseTo(2400)
  })

  it('returns no price for a token without the interface', async () => {
    const options = adapterOptions({ [WSTETH]: { decimals: 18 } })

    const result = await priceWith(wstEthAdapter(options), { [STETH]: 2000 }, WSTETH)

    expect(result.path).toBeNull()
  })
})
