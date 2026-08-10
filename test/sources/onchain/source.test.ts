import { describe, expect, it } from 'vitest'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import {
  createOnchainHistoricalSource,
  createOnchainSpotSource,
} from '../../../src/sources/onchain/source'
import type { MarketPriceResolver } from '../../../src/sources/onchain/types'

const TOKEN = '0x1111111111111111111111111111111111111111'

const noMarket: MarketPriceResolver = async () => null

describe('createOnchainSpotSource', () => {
  it('supports known chains only', () => {
    const source = createOnchainSpotSource({ marketPrice: noMarket })

    expect(source.supports(1)).toBe(true)
    expect(source.supports(1234)).toBe(false)
  })

  it('returns null when no adapter prices the token', async () => {
    const source = createOnchainSpotSource({ marketPrice: noMarket })

    await expect(source.getSpotPrice(1, TOKEN)).resolves.toBeNull()
  })

  it('surfaces a transient RPC failure instead of reporting no price', async () => {
    const source = createOnchainSpotSource({
      marketPrice: noMarket,
      clientForChain: () => {
        throw new RetryablePricingError('rpc down')
      },
    })

    await expect(source.getSpotPrice(1, TOKEN)).resolves.toBeNull()
  })
})

describe('createOnchainHistoricalSource', () => {
  it('returns null when no adapter prices the token', async () => {
    const source = createOnchainHistoricalSource({ marketPrice: noMarket })

    await expect(source.getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
  })
})
