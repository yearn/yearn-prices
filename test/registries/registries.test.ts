import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/http'
import {
  HistoricalSourceRegistry,
  historicalSourceRegistry,
  SpotSourceRegistry,
  spotSourceRegistry
} from '../../src/registries'
import type { HistoricalPrice, HistoricalPriceSource, SpotPrice, SpotPriceSource } from '../../src/sources'

const PRICE: SpotPrice = {
  price: 1,
  timestamp: 100,
  symbol: 'TOKEN',
  confidence: null,
  source: 'placeholder'
}

const HISTORICAL_PRICE: HistoricalPrice = {
  price: 1,
  timestamp: 100,
  symbol: 'TOKEN',
  confidence: null,
  source: 'placeholder'
}

function source(
  name: string,
  priority: number,
  getSpotPrice: SpotPriceSource['getSpotPrice'],
  supports = () => true
): SpotPriceSource {
  return { name, priority, supports, getSpotPrice }
}

function historicalSource(
  name: string,
  priority: number,
  getHistoricalPrice: HistoricalPriceSource['getHistoricalPrice'],
  supports = () => true
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
      })
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'first' })
    expect(calls).toEqual(['first'])
  })

  it('falls through when a source returns null', async () => {
    const fallback = vi.fn(async () => PRICE)
    const registry = new SpotSourceRegistry([source('empty', 1, async () => null), source('fallback', 2, fallback)])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls through when a source throws NOT_FOUND', async () => {
    const registry = new SpotSourceRegistry([
      source('missing', 1, async () => {
        throw new ApiError('NOT_FOUND', 'missing')
      }),
      source('fallback', 2, async () => PRICE)
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
  })

  it('rethrows a transient error when no fallback succeeds', async () => {
    const error = new Error('upstream down')
    const registry = new SpotSourceRegistry([
      source('broken', 1, async () => {
        throw error
      }),
      source(
        'unsupported',
        2,
        async () => PRICE,
        () => false
      )
    ])

    await expect(registry.resolve(1, '0xtoken')).rejects.toBe(error)
  })

  it('lets a working fallback mask a transient error', async () => {
    const registry = new SpotSourceRegistry([
      source('broken', 1, async () => {
        throw new Error('temporary failure')
      }),
      source('fallback', 2, async () => PRICE)
    ])

    await expect(registry.resolve(1, '0xtoken')).resolves.toEqual({ ...PRICE, source: 'fallback' })
  })

  it('rejects duplicate source names', () => {
    expect(
      () =>
        new SpotSourceRegistry([source('duplicate', 1, async () => PRICE), source('duplicate', 2, async () => PRICE)])
    ).toThrow('Duplicate spot price source name: duplicate')
  })
})

describe('HistoricalSourceRegistry', () => {
  it('uses priority order and stamps the winning source', async () => {
    const registry = new HistoricalSourceRegistry([
      historicalSource('later', 20, async () => HISTORICAL_PRICE),
      historicalSource('first', 10, async () => ({ ...HISTORICAL_PRICE, source: 'wrong' }))
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).resolves.toEqual({
      ...HISTORICAL_PRICE,
      source: 'first'
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
      })
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).rejects.toBe(error)
  })

  it('lets a working fallback mask a transient error', async () => {
    const registry = new HistoricalSourceRegistry([
      historicalSource('broken', 1, async () => {
        throw new Error('temporary failure')
      }),
      historicalSource('fallback', 2, async () => HISTORICAL_PRICE)
    ])

    await expect(registry.resolve(1, '0xtoken', 100)).resolves.toEqual({
      ...HISTORICAL_PRICE,
      source: 'fallback'
    })
  })

  describe('resolveBatch', () => {
    const target = (timestamp: number, chainId = 1) => ({ chainId, token: '0xtoken', timestamp })
    const settle = () => {
      const settled = new Map<number, PromiseSettledResult<HistoricalPrice>>()
      return {
        settled,
        onSettled: (t: { timestamp: number }, r: PromiseSettledResult<HistoricalPrice>) => settled.set(t.timestamp, r)
      }
    }

    it('sends only batch-unresolved targets through the source chain, batch source included', async () => {
      const single = vi.fn(async () => HISTORICAL_PRICE)
      const batch: HistoricalPriceSource = {
        ...historicalSource('defillama', 10, single),
        getBatchHistoricalPrices: async (targets) => [{ target: targets[0], price: { ...HISTORICAL_PRICE, price: 5 } }]
      }
      const fallback = vi.fn(async () => HISTORICAL_PRICE)
      const registry = new HistoricalSourceRegistry([historicalSource('chainlink', 20, fallback), batch])
      const { settled, onSettled } = settle()

      await registry.resolveBatch([target(1), target(2)], onSettled)

      expect(settled.get(1)).toEqual({
        status: 'fulfilled',
        value: { ...HISTORICAL_PRICE, price: 5, source: 'defillama' }
      })
      expect(settled.get(2)).toEqual({ status: 'fulfilled', value: { ...HISTORICAL_PRICE, source: 'defillama' } })
      expect(single).toHaveBeenCalledTimes(1)
      expect(fallback).not.toHaveBeenCalled()
    })

    it('skips the batch source single lookup when its batch group failed, and reports the batch error', async () => {
      const single = vi.fn(async () => HISTORICAL_PRICE)
      const rateLimited = new ApiError('RATE_LIMITED', 'defillama 429')
      const batch: HistoricalPriceSource = {
        ...historicalSource('defillama', 10, single),
        getBatchHistoricalPrices: async () => {
          throw rateLimited
        }
      }
      const fallback = vi.fn(async () => null)
      const registry = new HistoricalSourceRegistry([batch, historicalSource('chainlink', 20, fallback)])
      const { settled, onSettled } = settle()

      await registry.resolveBatch([target(1)], onSettled)

      expect(single).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledTimes(1)
      expect(settled.get(1)).toEqual({ status: 'rejected', reason: rateLimited })
    })

    it('runs the full chain for targets the batch source does not support', async () => {
      const batchCall = vi.fn(async () => [])
      const batch: HistoricalPriceSource = {
        ...historicalSource(
          'defillama',
          10,
          async () => HISTORICAL_PRICE,
          (chainId) => chainId === 1
        ),
        getBatchHistoricalPrices: batchCall
      }
      const fallback = vi.fn(async () => ({ ...HISTORICAL_PRICE, price: 9 }))
      const registry = new HistoricalSourceRegistry([batch, historicalSource('onchain', 30, fallback)])
      const { settled, onSettled } = settle()

      await registry.resolveBatch([target(1, 999)], onSettled)

      expect(batchCall).toHaveBeenCalledWith([], expect.any(Function))
      expect(settled.get(1)).toEqual({
        status: 'fulfilled',
        value: { ...HISTORICAL_PRICE, price: 9, source: 'onchain' }
      })
    })
  })

  it('rejects duplicate historical source names', () => {
    expect(
      () =>
        new HistoricalSourceRegistry([
          historicalSource('duplicate', 1, async () => HISTORICAL_PRICE),
          historicalSource('duplicate', 2, async () => HISTORICAL_PRICE)
        ])
    ).toThrow('Duplicate historical price source name: duplicate')
  })
})

describe('Per-request registries', () => {
  it('builds a fresh SpotSourceRegistry per request', () => {
    const env = { ENSO_API_KEY: 'test-key', DATABASE_URL: 'postgres://x' }
    const r1 = spotSourceRegistry(env)
    const r2 = spotSourceRegistry(env)
    expect(r1).toBeInstanceOf(SpotSourceRegistry)
    expect(r1).not.toBe(r2)
  })

  it('builds a fresh HistoricalSourceRegistry per request', () => {
    const env = { DATABASE_URL: 'postgres://x' }
    const r1 = historicalSourceRegistry(env)
    const r2 = historicalSourceRegistry(env)
    expect(r1).toBeInstanceOf(HistoricalSourceRegistry)
    expect(r1).not.toBe(r2)
  })
})
