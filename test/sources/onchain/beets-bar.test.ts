import { describe, expect, it } from 'vitest'
import { beetsBarAdapter } from '../../../src/sources/onchain/adapters/beets-bar'
import { adapterOptions, priceWith } from './helpers'

const BEETS_BAR = '0xfcef8a994209d6916eb2c86cdd2afd60aa6f54b1'
const OTHER = '0x1111111111111111111111111111111111111111'
const BPT = '0x3333333333333333333333333333333333333333'

describe('beetsBarAdapter', () => {
  it('prices the bar pro rata against its held BPT', async () => {
    const options = adapterOptions({
      [BEETS_BAR]: { vestingToken: BPT, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [BPT]: { decimals: 18, balanceOf: 200n * 10n ** 18n }
    })

    const result = await priceWith(beetsBarAdapter(options), { [BPT]: 5 }, BEETS_BAR, 250)

    expect(result.path?.priceUsd).toBeCloseTo(10)
  })

  it('ignores tokens outside the allowlist', async () => {
    const options = adapterOptions({ [OTHER]: { vestingToken: BPT, decimals: 18 } })

    const result = await priceWith(beetsBarAdapter(options), { [BPT]: 5 }, OTHER, 250)

    expect(result.path).toBeNull()
  })
})
