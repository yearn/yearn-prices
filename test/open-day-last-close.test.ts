import type { Pool } from '@neondatabase/serverless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_TODAY } from '../src/cache'
import type { HistoricalSourceRegistry } from '../src/registries'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleHistorical } from '../src/routes/historical/exact'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'

const RAW = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const TOKEN_KEY = `ethereum:${RAW}`
const CHECKSUM_KEY = `Ethereum:${CHECKSUM}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const PAST = 1695254399
const NOW = 1_787_911_200
const TODAY = normalizeToEndOfDay(NOW)

function exactRequest() {
  return new Request(`https://svc/api/prices/historical/${PAST}/${TOKEN_KEY}`)
}

function batchUrl(timestamps: number[]) {
  return new Request(
    `https://svc/api/prices/batchHistorical?coins=${encodeURIComponent(JSON.stringify({ [CHECKSUM_KEY]: timestamps }))}`
  )
}

function dbRow(timestamp: number, price: string, token = CHECKSUM) {
  return {
    chain: 'ethereum',
    token,
    timestamp: new Date(timestamp * 1000),
    price,
    symbol: 'WETH',
    confidence: '0.9',
    source: 'defillama'
  }
}

function resolvingRegistry(price = 27052): HistoricalSourceRegistry {
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

describe('current UTC day historical lookup', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exact: today EOD already in DB is a table hit, no Llama', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const queryPool = {
      query: vi.fn().mockResolvedValue({ rows: [dbRow(TODAY, '123.45')], rowCount: 1 })
    } as unknown as Pool

    const response = await handleHistorical(exactRequest(), ENV, queryPool, String(NOW - 600), TOKEN_KEY)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      coins: {
        [TOKEN_KEY]: {
          price: 123.45,
          symbol: 'WETH',
          timestamp: TODAY,
          confidence: 0.9,
          source: 'defillama'
        }
      }
    })
  })

  it('exact: today miss calls Llama once, persists today EOD, second request is a table hit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const registry = resolvingRegistry(27052)
    const stored: unknown[] = []
    const queryPool = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('INSERT INTO token_prices')) {
          stored.push(dbRow(TODAY, '27052'))
          return { rows: [], rowCount: 1 }
        }
        return { rows: stored, rowCount: stored.length }
      })
    } as unknown as Pool

    const first = await handleHistorical(exactRequest(), ENV, queryPool, String(NOW - 600), TOKEN_KEY, registry)
    expect(first.status).toBe(200)
    expect(registry.resolve).toHaveBeenCalledTimes(1)
    await expect(first.json()).resolves.toMatchObject({
      coins: { [TOKEN_KEY]: { price: 27052, timestamp: TODAY } }
    })
    expect(stored).toHaveLength(1)

    const second = await handleHistorical(exactRequest(), ENV, queryPool, String(NOW - 600), TOKEN_KEY, registry)
    expect(second.status).toBe(200)
    expect(registry.resolve).toHaveBeenCalledTimes(1)
    await expect(second.json()).resolves.toMatchObject({
      coins: { [TOKEN_KEY]: { price: 27052, timestamp: TODAY } }
    })
  })

  it('exact: closed-day table hit unchanged', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await handleHistorical(
      exactRequest(),
      ENV,
      { query: vi.fn(async () => ({ rows: [dbRow(PAST, '123.45', RAW)] })) } as unknown as Pool,
      String(PAST),
      TOKEN_KEY
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('batch: today EOD already in DB is a table hit, no Llama', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const registry = resolvingRegistry(1.5)
    const queryPool = {
      query: vi.fn().mockResolvedValue({ rows: [dbRow(TODAY, '1.5')], rowCount: 1 })
    } as unknown as Pool

    const response = await handleBatchHistorical(batchUrl([TODAY]), ENV, queryPool, registry)

    expect(registry.resolve).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [{ timestamp: TODAY, price: 1.5, confidence: 0.9, source: 'defillama' }]
        }
      }
    })
  })

  it('batch: today miss calls Llama once, persists today EOD, second request is a table hit', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const registry = resolvingRegistry(1.5)
    const stored: unknown[] = []
    const queryPool = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('INSERT INTO token_prices')) {
          stored.push(dbRow(TODAY, '1.5'))
          return { rows: [], rowCount: 1 }
        }
        return { rows: stored, rowCount: stored.length }
      })
    } as unknown as Pool

    const first = await handleBatchHistorical(batchUrl([TODAY]), ENV, queryPool, registry)
    expect(registry.resolve).toHaveBeenCalledTimes(1)
    await expect(first.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [{ timestamp: TODAY, price: 1.5, confidence: 0.99, source: 'defillama' }]
        }
      }
    })
    expect(stored).toHaveLength(1)

    const second = await handleBatchHistorical(batchUrl([TODAY]), ENV, queryPool, registry)
    expect(registry.resolve).toHaveBeenCalledTimes(1)
    await expect(second.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [{ timestamp: TODAY, price: 1.5, confidence: 0.9, source: 'defillama' }]
        }
      }
    })
  })
})
