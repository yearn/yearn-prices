import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/http'
import {
  getHistoricalSourceRegistry,
  getSpotSourceRegistry,
  HistoricalSourceRegistry,
  resetSourceRegistries,
  SpotSourceRegistry,
} from '../../src/registries'
import type {
  HistoricalPrice,
  HistoricalPriceSource,
  SpotPrice,
  SpotPriceSource,
} from '../../src/sources'

const PRICE: SpotPrice = {
  price: 1,
  timestamp: 100,
  symbol: 'TOKEN',
  confidence: null,
  source: 'placeholder',
}

const HISTORICAL_PRICE: HistoricalPrice = {
  price: 1,
  timestamp: 100,
  symbol: 'TOKEN',
  confidence: null,
  source: 'placeholder',
}

function source(
  name: string,
  priority: number,
  getSpotPrice: SpotPriceSource['getSpotPrice'],
  supports = () => true,
): SpotPriceSource {
  return { name, priority, supports, getSpotPrice }
}

function historicalSource(
  name: string,
  priority: number,
  getHistoricalPrice: HistoricalPriceSource['getHistoricalPrice'],
  supports = () => true,
): HistoricalPriceSource {
  return { name, priority, supports, getHistoricalPrice }
}

describe('SpotSourceRegistry', () => {
  it('tries sources in priority order and stamps the winning source', async () => {
    const calls: string[] = []
    const registry = new SpotSourceRegistry([
      source('later', 20, async () => {
        calls.push('later')
        return { ...PRICE, source: 'wrong' }
      }),
      source('first', 10, async () => {
        calls.push('first')
        return PRICE
      }),
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'first' })
    expect(calls).toEqual(['first'])
  })

  it('falls through when a source returns null', async () => {
    const fallback = vi.fn(async () => PRICE)
    const registry = new SpotSourceRegistry([
      source('empty', 1, async () => null),
      source('fallback', 2, fallback),
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls through when a source throws NOT_FOUND', async () => {
    const registry = new SpotSourceRegistry([
      source('missing', 1, async () => {
        throw new ApiError('NOT_FOUND', 'missing')
      }),
      source('fallback', 2, async () => PRICE),
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
  })

  it('rethrows a transient error when no fallback succeeds', async () => {
    const error = new Error('upstream down')
    const registry = new SpotSourceRegistry([
      source('broken', 1, async () => {
        throw error
      }),
      source('unsupported', 2, async () => PRICE, () => false),
    ])

    await expect(registry.resolve(1, '0xtoken')).rejects.toBe(error)
  })

  it('lets a working fallback mask a transient error', async () => {
    const registry = new SpotSourceRegistry([
      source('broken', 1, async () => {
        throw new Error('temporary failure')
      }),
      source('fallback', 2, async () => PRICE),
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
  })

  it('rejects duplicate source names', () => {
    expect(
      () =>
        new SpotSourceRegistry([
          source('duplicate', 1, async () => PRICE),
          source('duplicate', 2, async () => PRICE),
        ]),
    ).toThrow('Duplicate spot price source name: duplicate')
  })
})

describe('HistoricalSourceRegistry', () => {
  it('uses priority order and stamps the winning source', async () => {
    const registry = new HistoricalSourceRegistry([
      historicalSource('later', 20, async () => HISTORICAL_PRICE),
      historicalSource('first', 10, async () => ({ ...HISTORICAL_PRICE, source: 'wrong' })),
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).resolves.toEqual({
      ...HISTORICAL_PRICE,
      source: 'first',
    })
  })

  it('falls through null and NOT_FOUND, but rethrows a transient error when no fallback succeeds', async () => {
    const error = new Error('upstream down')
    const registry = new HistoricalSourceRegistry([
      historicalSource('empty', 1, async () => null),
      historicalSource('missing', 2, async () => {
        throw new ApiError('NOT_FOUND', 'missing')
      }),
      historicalSource('broken', 3, async () => {
        throw error
      }),
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).rejects.toBe(error)
  })

  it('lets a working fallback mask a transient error', async () => {
    const registry = new HistoricalSourceRegistry([
      historicalSource('broken', 1, async () => {
        throw new Error('temporary failure')
      }),
      historicalSource('fallback', 2, async () => HISTORICAL_PRICE),
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).resolves.toEqual({
      ...HISTORICAL_PRICE,
      source: 'fallback',
    })
  })

  it('rejects duplicate historical source names', () => {
    expect(
      () =>
        new HistoricalSourceRegistry([
          historicalSource('duplicate', 1, async () => HISTORICAL_PRICE),
          historicalSource('duplicate', 2, async () => HISTORICAL_PRICE),
        ]),
    ).toThrow('Duplicate historical price source name: duplicate')
  })
})

describe('Registry singletons', () => {
  beforeEach(() => {
    resetSourceRegistries()
  })

  it('reuses the same SpotSourceRegistry instance', () => {
    const env = { ENSO_API_KEY: 'test-key', DATABASE_URL: 'postgres://x' }
    const r1 = getSpotSourceRegistry(env)
    const r2 = getSpotSourceRegistry()
    expect(r1).toBeInstanceOf(SpotSourceRegistry)
    expect(r1).toBe(r2)
  })

  it('reuses the same HistoricalSourceRegistry instance', () => {
    const env = { DATABASE_URL: 'postgres://x' }
    const r1 = getHistoricalSourceRegistry(env)
    const r2 = getHistoricalSourceRegistry()
    expect(r1).toBeInstanceOf(HistoricalSourceRegistry)
    expect(r1).toBe(r2)
  })

  it('resets instances when resetSourceRegistries is called', () => {
    const env = { ENSO_API_KEY: 'test-key', DATABASE_URL: 'postgres://x' }
    const r1 = getSpotSourceRegistry(env)
    resetSourceRegistries()
    const r2 = getSpotSourceRegistry(env)
    expect(r1).not.toBe(r2)
  })
})
