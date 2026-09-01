import type { Pool } from '@neondatabase/serverless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_TODAY } from '../src/cache'
import type { HistoricalSourceRegistry } from '../src/registries'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleHistorical } from '../src/routes/historical/exact'
import type { Env } from '../src/types'
import { normalizeToEndOfDay, previousClosedDayEnd } from '../src/utils'

const RAW = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const TOKEN_KEY = `ethereum:${RAW}`
const CHECKSUM_KEY = `Ethereum:${CHECKSUM}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const PAST = 1695254399
const NOW = 1_787_911_200

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

function resolvingRegistry(): HistoricalSourceRegistry {
  return {
    resolve: vi.fn(async () => {
      throw new Error('llama should not be called')
    })
  } as unknown as HistoricalSourceRegistry
}

describe('open UTC day last-close', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exact: previous closed EOD present, no Llama', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const previous = previousClosedDayEnd(NOW)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const queryPool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [dbRow(previous, '123.45')], rowCount: 1 })
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
          timestamp: normalizeToEndOfDay(NOW),
          confidence: 0.9,
          source: 'defillama'
        }
      }
    })
  })

  it('exact: no previous closed row is NOT_FOUND, no Llama', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      handleHistorical(
        exactRequest(),
        ENV,
        { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool,
        String(NOW - 600),
        TOKEN_KEY
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('batch: previous closed EOD present, no Llama, requested day timestamp', async () => {
    const today = normalizeToEndOfDay(NOW)
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const previous = previousClosedDayEnd(NOW)
    const registry = resolvingRegistry()
    const queryPool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [dbRow(previous, '1.5')], rowCount: 1 })
    } as unknown as Pool

    const response = await handleBatchHistorical(batchUrl([today]), ENV, queryPool, registry)

    expect(registry.resolve).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [{ timestamp: today, price: 1.5, confidence: 0.9, source: 'defillama' }]
        }
      }
    })
  })

  it('batch: no previous row omits the coin and does not call Llama', async () => {
    const today = normalizeToEndOfDay(NOW)
    vi.useFakeTimers()
    vi.setSystemTime(NOW * 1000)
    const registry = resolvingRegistry()
    const response = await handleBatchHistorical(
      batchUrl([today]),
      ENV,
      { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool,
      registry
    )
    expect(registry.resolve).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({ coins: {} })
  })
})
