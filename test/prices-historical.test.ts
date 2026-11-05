import type { Pool } from '@neondatabase/serverless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_HISTORICAL, CACHE_CONTROL_TODAY } from '../src/cache'
import { ApiError } from '../src/http'
import worker from '../src/index'
import { handleHistorical } from '../src/routes/historical/exact'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'

vi.mock('../src/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db')>()),
  createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} })
}))

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const TOKEN_KEY = `ethereum:${RAW_ADDR}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const TIMESTAMP = 1695254399

function request(source?: string) {
  const query = source ? `?source=${source}` : ''
  return new Request(`https://svc/api/prices/historical/${TIMESTAMP}/${TOKEN_KEY}${query}`)
}

function pool(rows: unknown[]): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool
}

describe('handleHistorical', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requires revalidation for closed-day hits and keeps today short-lived', async () => {
    const today = normalizeToEndOfDay(Math.floor(Date.now() / 1000))
    const hit = (timestamp: number) =>
      handleHistorical(
        new Request(`https://svc/api/prices/historical/${timestamp}/${TOKEN_KEY}`),
        ENV,
        pool([
          {
            chain: 'ethereum',
            token: RAW_ADDR,
            timestamp: new Date(timestamp * 1000),
            price: '1',
            symbol: 'WETH',
            confidence: '0.9',
            source: 'defillama',
            updated_at: new Date()
          }
        ]),
        String(timestamp),
        TOKEN_KEY
      )

    expect((await hit(TIMESTAMP)).headers.get('cache-control')).toBe(CACHE_CONTROL_HISTORICAL)
    expect((await hit(today)).headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('returns a DB hit without calling an upstream source', async () => {
    const response = await handleHistorical(
      request(),
      ENV,
      pool([
        {
          chain: 'ethereum',
          token: RAW_ADDR,
          timestamp: new Date(TIMESTAMP * 1000),
          price: '123.45',
          symbol: 'WBTC',
          confidence: '0.9',
          source: 'defillama'
        }
      ]),
      String(TIMESTAMP),
      TOKEN_KEY
    )

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      coins: {
        [TOKEN_KEY]: {
          price: 123.45,
          symbol: 'WBTC',
          timestamp: TIMESTAMP,
          confidence: 0.9,
          source: 'defillama'
        }
      }
    })
  })

  it('does not fall back when an explicit source is requested', async () => {
    await expect(handleHistorical(request('enso'), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['chainlink', 'defillama-alias'])('returns NOT_FOUND for live-only source %s', async (source) => {
    await expect(handleHistorical(request(source), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND on a DB miss without calling upstream', async () => {
    await expect(handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('current day', () => {
    const today = normalizeToEndOfDay(Math.floor(Date.now() / 1000))
    const nowSeconds = () => Math.floor(Date.now() / 1000)
    const upstream = { price: 2425.5, timestamp: nowSeconds() - 20, symbol: 'WETH', confidence: 0.99 }
    const current = (price: typeof upstream | null = upstream) =>
      vi.fn(async () => new Map(price ? [[TOKEN_KEY, price]] : []))
    const todayRequest = (source?: string) =>
      new Request(`https://svc/api/prices/historical/${today}/${TOKEN_KEY}${source ? `?source=${source}` : ''}`)
    const todayRow = (updatedAgo: number) => ({
      chain: 'ethereum',
      token: RAW_ADDR,
      timestamp: new Date(today * 1000),
      price: '1',
      symbol: 'WETH',
      confidence: '0.9',
      source: 'defillama',
      observed_at: new Date((nowSeconds() - 10) * 1000),
      updated_at: new Date((nowSeconds() - updatedAgo) * 1000)
    })
    const insertCalls = (db: Pool) =>
      vi.mocked(db.query).mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO token_prices'))

    it('serves a table miss from one current call and persists it as provisional', async () => {
      const fetchCurrent = current()
      const db = pool([])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, fetchCurrent)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
      expect(fetchCurrent).toHaveBeenCalledTimes(1)
      expect(fetchCurrent).toHaveBeenCalledWith([
        { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }
      ])
      expect(db.query).toHaveBeenCalledTimes(2)
      const [insertSql, params] = insertCalls(db)[0] as unknown as [string, unknown[]]
      expect(insertSql).toContain('INSERT INTO token_prices')
      expect(params).toContain('/prices/current')
      expect(params).toContain(2425.5)
      expect(params).toContain(false)
      await expect(response.json()).resolves.toEqual({
        coins: {
          [TOKEN_KEY]: { price: 2425.5, symbol: 'WETH', timestamp: today, confidence: 0.99, source: 'defillama' }
        }
      })
    })

    it('serves a fresh row without calling upstream', async () => {
      const fetchCurrent = current()
      const db = pool([todayRow(10)])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, fetchCurrent)

      expect(fetchCurrent).not.toHaveBeenCalled()
      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
    })

    it('refetches, persists and serves the new price for a row written over 5 minutes ago', async () => {
      const fetchCurrent = current()
      const db = pool([todayRow(600)])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, fetchCurrent)

      expect(fetchCurrent).toHaveBeenCalledTimes(1)
      expect(insertCalls(db)).toHaveLength(1)
      await expect(response.json()).resolves.toMatchObject({
        coins: { [TOKEN_KEY]: { price: 2425.5, timestamp: today } }
      })
    })

    it('treats a row without updated_at as stale', async () => {
      const fetchCurrent = current()
      const { updated_at: _omitted, ...row } = todayRow(0)
      await handleHistorical(todayRequest(), ENV, pool([row]), String(today), TOKEN_KEY, fetchCurrent)

      expect(fetchCurrent).toHaveBeenCalledTimes(1)
    })

    it('serves the old row with a 200 when upstream fails and a row exists', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failing = vi.fn(async () => {
        throw new ApiError('INTERNAL_ERROR', 'DeFiLlama request failed with status 429')
      })
      const db = pool([todayRow(600)])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, failing)

      expect(response.status).toBe(200)
      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
      expect(String(error.mock.calls[0][0])).toContain('today-refresh-failed')
    })

    it('serves the old row when upstream has no price for it', async () => {
      const db = pool([todayRow(600)])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, current(null))

      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
    })

    it('propagates an upstream failure on a miss and returns NOT_FOUND when upstream has no price', async () => {
      const failing = vi.fn(async () => {
        throw new ApiError('INTERNAL_ERROR', 'DeFiLlama request failed with status 429')
      })
      await expect(
        handleHistorical(todayRequest(), ENV, pool([]), String(today), TOKEN_KEY, failing)
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })

      const db = pool([])
      await expect(
        handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, current(null))
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(insertCalls(db)).toHaveLength(0)
    })

    it('stays table-only for closed days and explicit sources', async () => {
      const fetchCurrent = current()
      const miss = (req: Request, ts: number) =>
        expect(handleHistorical(req, ENV, pool([]), String(ts), TOKEN_KEY, fetchCurrent)).rejects.toMatchObject({
          code: 'NOT_FOUND'
        })

      await miss(request(), TIMESTAMP)
      await miss(todayRequest('defillama'), today)
      expect(fetchCurrent).not.toHaveBeenCalled()
    })
  })

  it('serves a table miss as a 404 whose negative TTL stays under the hourly warmup cadence', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } })
    const response = await worker.fetch(
      new Request(request().url, { headers: { authorization: 'Bearer k' } }),
      { ...ENV, API_KEY_TEST: 'k' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=300, max-age=300')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('hyperliquid', () => {
    const HYPE_USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f'
    const HYPE_KEY = `hyperliquid:${HYPE_USDC}`
    const workerFetch = (key: string) => {
      vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } })
      return worker.fetch(
        new Request(`https://svc/api/prices/historical/${TIMESTAMP}/${key}`, {
          headers: { authorization: 'Bearer k' }
        }),
        { ...ENV, API_KEY_TEST: 'k' } as unknown as Env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext
      )
    }

    it('returns the stored quote with its provenance', async () => {
      const response = await handleHistorical(
        request(),
        ENV,
        pool([
          {
            chain: 'hyperliquid',
            token: HYPE_USDC,
            timestamp: new Date(TIMESTAMP * 1000),
            price: '0.9998',
            symbol: 'USDC',
            confidence: '0.99',
            source: 'defillama'
          }
        ]),
        String(TIMESTAMP),
        HYPE_KEY
      )

      await expect(response.json()).resolves.toEqual({
        coins: {
          [HYPE_KEY]: { price: 0.9998, symbol: 'USDC', timestamp: TIMESTAMP, confidence: 0.99, source: 'defillama' }
        }
      })
    })

    it('returns NOT_FOUND instead of an invented price when nothing is stored', async () => {
      await expect(handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), HYPE_KEY)).rejects.toMatchObject({
        code: 'NOT_FOUND'
      })
    })

    it.each(['hyperevm', 'fakechain'])('maps unsupported namespace %s to a 400', async (chain) => {
      const response = await workerFetch(`${chain}:${HYPE_USDC}`)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: { code: 'INVALID_INPUT', message: `Unsupported chain: ${chain}` }
      })
    })

    it('maps a malformed token address to a 400', async () => {
      expect((await workerFetch('ethereum:0xnothex')).status).toBe(400)
    })
  })
})
