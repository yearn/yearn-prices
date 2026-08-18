import { describe, expect, it } from 'vitest'
import { DEFAULT_PENDLE_TWAP_SECONDS, pendleAdapter } from '../../../src/sources/onchain/adapters/pendle'
import { adapterOptions, priceWith } from './helpers'

const MARKET = '0x1111111111111111111111111111111111111111'
const SY = '0x2222222222222222222222222222222222222222'
const PT = '0x3333333333333333333333333333333333333333'
const YT = '0x4444444444444444444444444444444444444444'
const ASSET = '0x5555555555555555555555555555555555555555'
const ORACLE = '0x9a9fa8338dd5e5b2188006f1cd2ef26d921650c2'
const WAD = 10n ** 18n

describe('pendleAdapter', () => {
  const reads = {
    [MARKET]: { readTokens: [SY, PT, YT] },
    [SY]: { assetInfo: [1, ASSET, 18] },
    [ORACLE]: { getLpToAssetRate: 2n * WAD }
  }

  it('prices an LP from the oracle TWAP rate', async () => {
    const result = await priceWith(
      pendleAdapter(adapterOptions(reads), DEFAULT_PENDLE_TWAP_SECONDS),
      { [ASSET]: 3 },
      MARKET
    )

    expect(result.path?.priceUsd).toBeCloseTo(6)
    expect(result.path?.metadata.twapSeconds).toBe(DEFAULT_PENDLE_TWAP_SECONDS)
  })

  it('returns no price for a token that is not a Pendle market', async () => {
    const result = await priceWith(
      pendleAdapter(adapterOptions({ [MARKET]: { decimals: 18 } }), 900),
      { [ASSET]: 3 },
      MARKET
    )

    expect(result.path).toBeNull()
  })

  it('rejects a TWAP window that does not fit uint32', () => {
    expect(() => pendleAdapter(adapterOptions({}), 0)).toThrow()
    expect(() => pendleAdapter(adapterOptions({}), 2 ** 32)).toThrow()
  })
})
