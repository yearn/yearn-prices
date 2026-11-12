import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHistoricalSources, HistoricalSourceRegistry } from '../../src/registries/historical'
import * as marketPriceModule from '../../src/registries/market-price'
import { createSpotSources } from '../../src/registries/spot'
import type { Env } from '../../src/types'

const spy = vi.spyOn(marketPriceModule, 'createMarketPriceResolver')

const env = { ENSO_API_KEY: 'test-key' } as unknown as Env

describe('source wiring', () => {
  beforeEach(() => {
    spy.mockClear()
  })

  it('never lets the spot child resolver see the on-chain source', () => {
    const sources = createSpotSources(env)

    expect(sources.map((source) => source.name)).toEqual(['enso', 'defillama', 'chainlink', 'derived'])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((source) => source.name)).toEqual(['enso', 'defillama', 'chainlink'])
  })

  it('keeps independent spot sources available without an Enso key', () => {
    const sources = createSpotSources({} as Env)

    expect(sources.map((source) => source.name)).toEqual(['defillama', 'chainlink', 'derived'])
    expect(spy.mock.calls[0][0].map((source) => source.name)).toEqual(['defillama', 'chainlink'])
  })

  it('calls spot providers directly, never through the gateway', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ price: 1, symbol: 'X', timestamp: Date.now() }))
    const sources = createSpotSources({
      ...env,
      PRICE_GATEWAY_URL: 'https://gateway.test',
      PRICE_GATEWAY_TOKEN: 'gateway-token'
    } as unknown as Env)

    try {
      await sources[0].getSpotPrice(1, '0xd533a949740bb3306d119cc777fa900ba034cd52')
      const hosts = fetchSpy.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : String(input)).host
      )
      expect(hosts).toEqual(['api.enso.build'])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('exposes chainlink in the historical registry and to the child resolver', () => {
    const sources = createHistoricalSources(env)

    expect(sources.map((source) => source.name)).toEqual(['defillama', 'chainlink', 'defillama-alias', 'derived'])
    expect(spy.mock.calls[0][0].map((source) => source.name)).toContain('chainlink')
  })

  it('tries chainlink after defillama and before the on-chain source', () => {
    const registry = new HistoricalSourceRegistry(createHistoricalSources(env))

    expect(registry.all().map((source) => source.name)).toEqual([
      'defillama',
      'chainlink',
      'derived',
      'defillama-alias'
    ])
  })

  it('adds the optional block-priced source to historical roots and market leaves', () => {
    const sources = createHistoricalSources({
      ...env,
      YPRICEAPI_SIGNER: 'signer',
      YPRICEAPI_SIGNATURE: 'signature'
    })
    expect(new HistoricalSourceRegistry(sources).all().map((source) => source.name)).toEqual([
      'defillama',
      'chainlink',
      'bobs-api',
      'derived',
      'defillama-alias'
    ])
    expect(spy.mock.calls[0][0].map((source) => source.name)).toContain('bobs-api')
  })

  it('never lets the historical child resolver see the on-chain source', () => {
    const sources = createHistoricalSources(env)

    expect(sources.map((source) => source.name)).toContain('derived')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((source) => source.name)).not.toContain('derived')
  })
})
