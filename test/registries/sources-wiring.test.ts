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

  it('reaches only Enso for spot', () => {
    expect(createSpotSources(env).map((source) => source.name)).toEqual(['enso'])
    expect(createSpotSources({} as Env)).toEqual([])
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
