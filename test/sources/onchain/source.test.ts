import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../src/http/errors'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import {
  createOnchainHistoricalSource,
  createOnchainSpotSource,
} from '../../../src/sources/onchain/source'
import type { MarketPriceResolver } from '../../../src/sources/onchain/types'
import { fakeClient } from './helpers'

const TOKEN = '0x1111111111111111111111111111111111111111'

const noMarket: MarketPriceResolver = async () => null
const noClient = () => null
const emptyClient = () => fakeClient({ [TOKEN]: { decimals: 18 } })

describe('createOnchainSpotSource', () => {
  it('supports known chains that have a configured RPC', () => {
    const source = createOnchainSpotSource({
      marketPrice: noMarket,
      clientForChain: emptyClient,
    })

    expect(source.supports(1)).toBe(true)
    expect(source.supports(1234)).toBe(false)
  })

  it('does not support a chain without a configured RPC', () => {
    const source = createOnchainSpotSource({ marketPrice: noMarket, clientForChain: noClient })

    expect(source.supports(1)).toBe(false)
  })

  it('returns null when no adapter prices the token', async () => {
    const source = createOnchainSpotSource({
      marketPrice: noMarket,
      clientForChain: emptyClient,
    })

    await expect(source.getSpotPrice(1, TOKEN)).resolves.toBeNull()
  })

  it('returns null rather than an error when the RPC is unconfigured', async () => {
    const source = createOnchainSpotSource({ marketPrice: noMarket, clientForChain: noClient })

    await expect(source.getSpotPrice(1, TOKEN)).resolves.toBeNull()
  })

  it('surfaces a transient RPC failure instead of reporting no price', async () => {
    const source = createOnchainSpotSource({
      marketPrice: noMarket,
      clientForChain: () =>
        fakeClient({ [TOKEN]: { decimals: new RetryablePricingError('rpc down') } }),
    })

    await expect(source.getSpotPrice(1, TOKEN)).rejects.toBeInstanceOf(RetryablePricingError)
  })

  it('does not leak an rpc url from an injected client error', async () => {
    const leaked = Object.assign(
      new Error('http request failed https://rpc.example/SECRETKEY'),
      { name: 'HttpRequestError', status: 502 },
    )
    const source = createOnchainSpotSource({
      marketPrice: noMarket,
      clientForChain: () => fakeClient({ [TOKEN]: { decimals: leaked } }),
    })

    const error = await source.getSpotPrice(1, TOKEN).then(
      () => {
        throw new Error('expected rejection')
      },
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(RetryablePricingError)
    expect(error instanceof Error ? error.message : '').not.toMatch(/https?:|SECRETKEY|rpc\.example/)
    expect(String(error)).not.toMatch(/SECRETKEY/)
  })

  it('does not claim a chain when worker env has no rpc binding', () => {
    const source = createOnchainSpotSource({ marketPrice: noMarket, env: { DATABASE_URL: 'x' } })

    expect(source.supports(1)).toBe(false)
  })

  it('rethrows an upstream ApiError as itself', async () => {
    const underlying = '0x2222222222222222222222222222222222222222'
    const source = createOnchainSpotSource({
      marketPrice: async (target) => {
        if (target.token.toLowerCase() === underlying) {
          throw new ApiError('INTERNAL_ERROR', 'upstream exploded')
        }
        return null
      },
      clientForChain: () =>
        fakeClient({
          [TOKEN]: { asset: underlying, decimals: 18, convertToAssets: 10n ** 18n },
          [underlying]: { decimals: 18 },
        }),
    })

    await expect(source.getSpotPrice(1, TOKEN)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INTERNAL_ERROR',
    })
  })
})

describe('createOnchainHistoricalSource', () => {
  it('returns null when no adapter prices the token', async () => {
    const source = createOnchainHistoricalSource({
      marketPrice: noMarket,
      clientForChain: emptyClient,
    })

    await expect(source.getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
  })
})
