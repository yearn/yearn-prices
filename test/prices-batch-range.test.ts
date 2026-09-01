import type { Pool } from '@neondatabase/serverless'
import { describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_PARTIAL, CACHE_CONTROL_TODAY } from '../src/cache'
import { ApiError } from '../src/http'
import { HistoricalSourceRegistry } from '../src/registries'
import { createMarketPriceResolver } from '../src/registries/market-price'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleRangeHistorical } from '../src/routes/historical/range'
import { createOnchainHistoricalSource } from '../src/sources/onchain'
import type { HistoricalPriceSource, HistoricalPriceTarget } from '../src/sources/types'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'
import { BLOCK_TIMESTAMP, fakeClient } from './sources/onchain/helpers'

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const CHECKSUM_KEY = `Ethereum:${CHECKSUM_ADDR}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const DAY_ONE = 1695254399
const DAY_TWO = 1695340799
const TODAY = normalizeToEndOfDay(Math.floor(Date.now() / 1000))

function url(path: string, coins: unknown, extra = '') {
  return new Request(`https://svc/api/prices/${path}?coins=${encodeURIComponent(JSON.stringify(coins))}${extra}`)
}

function row(timestamp: number, price: string, source = 'defillama') {
  return {
    chain: 'ethereum',
    token: CHECKSUM_ADDR,
    timestamp: new Date(timestamp * 1000),
    price,
    symbol: 'WETH',
    confidence: '0.9',
    source
  }
}

function pool(rows: unknown[]): Pool {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as Pool
}

function notFoundRegistry(): HistoricalSourceRegistry {
  return {
    resolve: vi.fn(async () => {
      throw new ApiError('NOT_FOUND', 'No historical price available for this token')
    })
  } as unknown as HistoricalSourceRegistry
}

function resolvingRegistry(price: number): HistoricalSourceRegistry {
  return {
    resolve: vi.fn(async (_chainId: number, _token: string, timestamp: number) => ({
      price,
      timestamp,
      symbol: 'WETH',
      confidence: 0.99,
      source: 'defillama'
    }))
  } as unknown as HistoricalSourceRegistry
}

describe('handleBatchHistorical', () => {
  it('groups rows under the caller original token key and sorts by timestamp', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_TWO, DAY_ONE] }),
      ENV,
      pool([row(DAY_TWO, '2'), row(DAY_ONE, '1')])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [
            { timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' },
            { timestamp: DAY_TWO, price: 2, confidence: 0.9, source: 'defillama' }
          ]
        }
      }
    })
  })

  it('marks a fully resolved past batch immutable', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('marks an incomplete past batch partial when upstream cannot resolve the gap', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      notFoundRegistry()
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('resolves table misses upstream, persists them, and returns a complete batch', async () => {
    const queryPool = pool([row(DAY_ONE, '1')])
    const registry = resolvingRegistry(2)

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      queryPool,
      registry
    )

    expect(registry.resolve).toHaveBeenCalledTimes(1)
    expect(registry.resolve).toHaveBeenCalledWith(1, CHECKSUM_ADDR, DAY_TWO)
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall?.[1]).toContain(CHECKSUM_ADDR)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [
            { timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' },
            { timestamp: DAY_TWO, price: 2, confidence: 0.99, source: 'defillama' }
          ]
        }
      }
    })
  })

  it('uses a provider batch method instead of one request per miss', async () => {
    const otherAddress = '0x6b175474e89094c44da98b954eedeac495271d0f'
    const getHistoricalPrice = vi.fn(async () => {
      throw new Error('individual path should not run')
    })
    const getBatchHistoricalPrices = vi.fn(async (targets: HistoricalPriceTarget[]) =>
      targets.map((target) => ({
        target,
        price: {
          price: 2,
          timestamp: target.timestamp,
          symbol: 'TOKEN',
          confidence: 0.99
        }
      }))
    )
    const source: HistoricalPriceSource = {
      name: 'defillama',
      priority: 10,
      supports: () => true,
      getHistoricalPrice,
      getBatchHistoricalPrices
    }
    const registry = new HistoricalSourceRegistry([source])

    const response = await handleBatchHistorical(
      url('batchHistorical', {
        [CHECKSUM_KEY]: [DAY_ONE],
        [`ethereum:${otherAddress}`]: [DAY_ONE]
      }),
      ENV,
      pool([]),
      registry
    )

    expect(response.status).toBe(200)
    expect(getBatchHistoricalPrices).toHaveBeenCalledTimes(1)
    expect(getBatchHistoricalPrices.mock.calls[0][0]).toHaveLength(2)
    expect(getHistoricalPrice).not.toHaveBeenCalled()
  })

  it('returns completed partial results when the route resolution deadline expires', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const registry = {
      resolve: vi.fn(() => new Promise<never>(() => undefined))
    } as unknown as HistoricalSourceRegistry

    try {
      const responsePromise = handleBatchHistorical(
        url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
        ENV,
        pool([row(DAY_ONE, '1')]),
        registry
      )
      await vi.advanceTimersByTimeAsync(5_000)
      const response = await responsePromise

      expect(response.status).toBe(200)
      const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
      expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(1)
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('batch-resolution-deadline'))
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('leaves a failed upstream resolution absent instead of failing the batch', async () => {
    const registry = {
      resolve: vi.fn(async () => {
        throw new Error('defillama 503')
      })
    } as unknown as HistoricalSourceRegistry

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      registry
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(1)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('resolves duplicate-cased keys for the same token once and keeps the immutable header', async () => {
    const queryPool = pool([])
    const registry = resolvingRegistry(2)

    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE], [CHECKSUM_KEY]: [DAY_ONE] }),
      ENV,
      queryPool,
      registry
    )

    expect(registry.resolve).toHaveBeenCalledTimes(1)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(Object.values(body.coins)).toHaveLength(1)
    expect(Object.values(body.coins)[0].prices).toHaveLength(1)
  })

  it('still returns 200 with resolved prices when the persistence write fails', async () => {
    const queryPool = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('INSERT INTO token_prices')) throw new Error('write failed')
        return { rows: [row(DAY_ONE, '1')], rowCount: 1 }
      })
    } as unknown as Pool

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      queryPool,
      resolvingRegistry(2)
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(2)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('does not mark a batch immutable when a resolution falls outside the observation window', async () => {
    const registry = {
      resolve: vi.fn(async (_chainId: number, _token: string, timestamp: number) => ({
        price: 2,
        timestamp: timestamp - 86_400,
        symbol: 'WETH',
        confidence: 0.99,
        source: 'defillama'
      }))
    } as unknown as HistoricalSourceRegistry

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      registry
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(2)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('serves but does not persist a derived observation outside the search window', async () => {
    const queryPool = pool([])
    const registry = {
      resolve: vi.fn(async (_chainId: number, _token: string, timestamp: number) => ({
        price: 2,
        timestamp: timestamp - 2 * 86_400,
        symbol: 'WETH',
        confidence: 0.99,
        source: 'derived'
      }))
    } as unknown as HistoricalSourceRegistry

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE] }),
      ENV,
      queryPool,
      registry
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toEqual([
      { timestamp: DAY_ONE, price: 2, confidence: 0.99, source: 'derived' }
    ])
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeUndefined()
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('persists a chainlink observation older than the search window', async () => {
    const queryPool = pool([])
    const registry = {
      resolve: vi.fn(async (_chainId: number, _token: string, timestamp: number) => ({
        price: 2,
        timestamp: timestamp - 2 * 86_400,
        symbol: 'WETH',
        confidence: 0.99,
        source: 'chainlink'
      }))
    } as unknown as HistoricalSourceRegistry

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_ONE] }),
      ENV,
      queryPool,
      registry
    )

    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeDefined()
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('persists a derived price whose chainlink leaf is older than the search window', async () => {
    const vault = '0x5555555555555555555555555555555555555555'
    const day = normalizeToEndOfDay(BLOCK_TIMESTAMP)
    const chainlink: HistoricalPriceSource = {
      name: 'chainlink',
      priority: 15,
      supports: (chainId) => chainId === 1,
      getHistoricalPrice: async (_chainId, token, timestamp) =>
        token.toLowerCase() === RAW_ADDR
          ? { price: 1000, timestamp: timestamp - 7 * 3_600, symbol: null, confidence: null }
          : null
    }
    const sources = [chainlink]
    const registry = new HistoricalSourceRegistry(sources)
    const derived = createOnchainHistoricalSource({
      marketPrice: createMarketPriceResolver(
        sources,
        (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
        { requireTimestamp: true }
      ),
      clientForChain: () =>
        fakeClient({
          [vault]: { asset: RAW_ADDR, decimals: 18, convertToAssets: 2n * 10n ** 18n },
          [RAW_ADDR]: { decimals: 18 }
        })
    })
    const queryPool = pool([])

    const response = await handleBatchHistorical(
      url('batchHistorical', { [`Ethereum:${vault}`]: [day] }),
      ENV,
      queryPool,
      new HistoricalSourceRegistry([chainlink, derived])
    )

    const body = (await response.json()) as { coins: Record<string, { prices: { source: string }[] }> }
    expect(body.coins[`Ethereum:${vault}`].prices[0].source).toBe('derived')
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeDefined()
  })

  it('does not persist a today-resolved miss', async () => {
    const queryPool = pool([])

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [TODAY] }),
      ENV,
      queryPool,
      resolvingRegistry(2)
    )

    expect(response.status).toBe(200)
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeUndefined()
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(1)
  })

  it('does not persist a future-day resolved miss', async () => {
    const queryPool = pool([])
    const future = TODAY + 86_400

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [future] }),
      ENV,
      queryPool,
      resolvingRegistry(2)
    )

    expect(response.status).toBe(200)
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeUndefined()
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[CHECKSUM_KEY].prices).toHaveLength(1)
  })

  it('never marks a batch touching a future day immutable', async () => {
    const future = TODAY + 86_400

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [future] }),
      ENV,
      pool([]),
      resolvingRegistry(2)
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('spreads the resolution budget across tokens so a starving token still resolves', async () => {
    const OTHER_ADDR = '0x6b175474e89094c44da98b954eedeac495271d0f'
    const OTHER_KEY = `ethereum:${OTHER_ADDR}`
    const blockedDays = Array.from({ length: 12 }, (_, index) => DAY_ONE - index * 86_400)
    const registry = {
      resolve: vi.fn(async (_chainId: number, token: string, timestamp: number) => {
        if (token.toLowerCase() !== OTHER_ADDR) {
          throw new Error('defillama 503')
        }
        return { price: 7, timestamp, symbol: 'DAI', confidence: 0.99, source: 'defillama' }
      })
    } as unknown as HistoricalSourceRegistry

    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: blockedDays, [OTHER_KEY]: [DAY_TWO] }),
      ENV,
      pool([]),
      registry
    )

    const body = (await response.json()) as { coins: Record<string, { prices: { price: number }[] }> }
    expect(body.coins[OTHER_KEY].prices).toEqual([
      { timestamp: DAY_TWO, price: 7, confidence: 0.99, source: 'defillama' }
    ])
  })

  it('spends the budget on closed-day misses before unclosed-day ones', async () => {
    const coins = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`ethereum:0x${String(index + 1).padStart(40, '0')}`, [TODAY, DAY_ONE]])
    )
    const queryPool = pool([])
    const registry = resolvingRegistry(3)

    await handleBatchHistorical(url('batchHistorical', coins), ENV, queryPool, registry)

    const resolved = (registry.resolve as ReturnType<typeof vi.fn>).mock.calls
    expect(resolved).toHaveLength(10)
    expect(resolved.map((call) => call[2])).toEqual(Array(10).fill(DAY_ONE))
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeDefined()
  })

  it('does not resolve misses upstream when an explicit source is requested', async () => {
    const registry = resolvingRegistry(2)

    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=enso'),
      ENV,
      pool([]),
      registry
    )

    expect(registry.resolve).not.toHaveBeenCalled()
  })

  it('marks a batch touching today with the short-lived policy', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY] }),
      ENV,
      pool([row(TODAY, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('passes an explicit source through to the query', async () => {
    const queryPool = pool([row(DAY_ONE, '1', 'enso')])
    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=enso'),
      ENV,
      queryPool
    )

    expect(queryPool.query.mock.calls[0][1]).toContain('enso')
  })

  it('returns an empty batch for a live-only source instead of failing', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=chainlink'),
      ENV,
      pool([])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ coins: {} })
  })

  it('rejects an unsupported source', async () => {
    await expect(
      handleBatchHistorical(
        url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=nope'),
        ENV,
        pool([])
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('handleRangeHistorical', () => {
  it('groups a range under the caller original token key', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1'), row(DAY_TWO, '2')])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [
            { timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' },
            { timestamp: DAY_TWO, price: 2, confidence: 0.9, source: 'defillama' }
          ]
        }
      }
    })
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('marks a range with a missing day partial', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('marks a range ending today with the short-lived policy', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY, TODAY] }),
      ENV,
      pool([row(TODAY, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('rejects a reversed range', async () => {
    await expect(
      handleRangeHistorical(url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_TWO, DAY_ONE] }), ENV, pool([]))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
