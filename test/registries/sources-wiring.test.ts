import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHistoricalSources } from '../../src/registries/historical'
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

    expect(sources.map((source) => source.name)).toContain('derived')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((source) => source.name)).not.toContain('derived')
  })

  it('exposes chainlink in the historical registry and to the child resolver', () => {
    const sources = createHistoricalSources(env)

    expect(sources.map((source) => source.name)).toEqual(['defillama', 'chainlink', 'defillama-alias', 'derived'])
    expect(spy.mock.calls[0][0].map((source) => source.name)).toContain('chainlink')
  })

  it('never lets the historical child resolver see the on-chain source', () => {
    const sources = createHistoricalSources(env)

    expect(sources.map((source) => source.name)).toContain('derived')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].map((source) => source.name)).not.toContain('derived')
  })
})
