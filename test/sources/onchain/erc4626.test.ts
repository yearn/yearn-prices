import { describe, expect, it } from 'vitest'
import { erc4626Adapter } from '../../../src/sources/onchain/adapters/erc4626'
import { adapterOptions, priceWith } from './helpers'

const VAULT = '0x1111111111111111111111111111111111111111'
const UNDERLYING = '0x2222222222222222222222222222222222222222'

describe('erc4626Adapter', () => {
  it('prices a share from convertToAssets and the underlying price', async () => {
    const options = adapterOptions({
      [VAULT]: { asset: UNDERLYING, decimals: 18, convertToAssets: 1_100_000n },
      [UNDERLYING]: { decimals: 6 },
    })

    const result = await priceWith(erc4626Adapter(options), { [UNDERLYING]: 2 }, VAULT)

    expect(result.path?.priceUsd).toBeCloseTo(2.2)
    expect(result.path?.metadata.method).toBe('convertToAssets')
  })

  it('falls back to previewRedeem when convertToAssets reverts', async () => {
    const options = adapterOptions({
      [VAULT]: { asset: UNDERLYING, decimals: 18, previewRedeem: 2n * 10n ** 6n },
      [UNDERLYING]: { decimals: 6 },
    })

    const result = await priceWith(erc4626Adapter(options), { [UNDERLYING]: 3 }, VAULT)

    expect(result.path?.priceUsd).toBeCloseTo(6)
    expect(result.path?.metadata.method).toBe('previewRedeem')
  })

  it('returns no price when the token is not a vault', async () => {
    const options = adapterOptions({ [VAULT]: { decimals: 18 } })

    const result = await priceWith(erc4626Adapter(options), {}, VAULT)

    expect(result.path).toBeNull()
  })

  it('rejects a vault whose asset is itself', async () => {
    const options = adapterOptions({ [VAULT]: { asset: VAULT, decimals: 18 } })

    const result = await priceWith(erc4626Adapter(options), { [VAULT]: 1 }, VAULT)

    expect(result.path).toBeNull()
  })

  it('fails when the underlying has no price', async () => {
    const options = adapterOptions({
      [VAULT]: { asset: UNDERLYING, decimals: 18, convertToAssets: 10n ** 18n },
      [UNDERLYING]: { decimals: 18 },
    })

    const result = await priceWith(erc4626Adapter(options), {}, VAULT)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })
})
