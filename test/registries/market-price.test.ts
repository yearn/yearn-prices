import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/http/errors'
import { createMarketPriceResolver } from '../../src/registries/market-price'

const TOKEN = '0x1111111111111111111111111111111111111111'

const quote = {
  price: 2,
  timestamp: 1_700_000_000,
  symbol: 'TKN',
  confidence: 0.9,
  source: 'enso'
}

const mainnetOnly = [{ supports: (chainId: number) => chainId === 1 }]

describe('createMarketPriceResolver', () => {
  it('maps a market quote onto a resolved price path', async () => {
    const resolve = createMarketPriceResolver(mainnetOnly, async () => quote)

    const path = await resolve({ chainId: 1, token: TOKEN, timestamp: null, blockNumber: 42 })

    expect(path).toMatchObject({
      chainId: 1,
      token: TOKEN,
      requestedTimestamp: null,
      observedTimestamp: quote.timestamp,
      priceUsd: quote.price,
      symbol: 'TKN',
      confidence: 0.9,
      source: 'enso',
      adapter: 'enso',
      blockNumber: 42,
      inputs: []
    })
  })

  it('returns null without resolving when no source supports the chain', async () => {
    const fetch = vi.fn(async () => quote)
    const resolve = createMarketPriceResolver(mainnetOnly, fetch)

    await expect(resolve({ chainId: 137, token: TOKEN, timestamp: null })).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads NOT_FOUND as no market price', async () => {
    const resolve = createMarketPriceResolver(mainnetOnly, async () => {
      throw new ApiError('NOT_FOUND', 'no price')
    })

    await expect(resolve({ chainId: 1, token: TOKEN, timestamp: null })).resolves.toBeNull()
  })

  it('rethrows every other market failure', async () => {
    const resolve = createMarketPriceResolver(mainnetOnly, async () => {
      throw new ApiError('INTERNAL_ERROR', 'upstream exploded')
    })

    await expect(resolve({ chainId: 1, token: TOKEN, timestamp: null })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    })
  })

  it('refuses a timestampless target when a timestamp is required', async () => {
    const fetch = vi.fn(async () => quote)
    const resolve = createMarketPriceResolver(mainnetOnly, fetch, { requireTimestamp: true })

    await expect(resolve({ chainId: 1, token: TOKEN, timestamp: null })).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    const path = await resolve({ chainId: 1, token: TOKEN, timestamp: quote.timestamp })
    expect(path?.priceUsd).toBe(quote.price)
  })
})
