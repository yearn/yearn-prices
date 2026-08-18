import { describe, expect, it } from 'vitest'
import { nativeShareAdapter } from '../../../src/sources/onchain/adapters/native-share'
import { adapterOptions, priceWith } from './helpers'

const NATIVE_SHARE = '0x09db87a538bd693e9d08544577d5ccfaa6373a48'
const OTHER = '0x1111111111111111111111111111111111111111'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

describe('nativeShareAdapter', () => {
  it('prices an allowlisted native wrapper against wrapped native', async () => {
    const options = adapterOptions({
      [NATIVE_SHARE]: { decimals: 18, convertToAssets: 2n * 10n ** 18n }
    })

    const result = await priceWith(nativeShareAdapter(options), { [WETH]: 1500 }, NATIVE_SHARE)

    expect(result.path?.priceUsd).toBeCloseTo(3000)
  })

  it('ignores tokens outside the allowlist', async () => {
    const options = adapterOptions({ [OTHER]: { decimals: 18, convertToAssets: 10n ** 18n } })

    const result = await priceWith(nativeShareAdapter(options), { [WETH]: 1500 }, OTHER)

    expect(result.path).toBeNull()
  })

  it('rejects a zero share conversion as invalid', async () => {
    const options = adapterOptions({
      [NATIVE_SHARE]: { decimals: 18, convertToAssets: 0n }
    })

    const result = await priceWith(nativeShareAdapter(options), { [WETH]: 1500 }, NATIVE_SHARE)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('ignores chains with no wrapped native asset', async () => {
    const options = adapterOptions({
      [NATIVE_SHARE]: { decimals: 18, convertToAssets: 10n ** 18n }
    })

    const result = await priceWith(nativeShareAdapter(options), {}, NATIVE_SHARE, 146)

    expect(result.path).toBeNull()
  })
})
