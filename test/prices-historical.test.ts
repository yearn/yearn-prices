import type { Pool } from '@neondatabase/serverless'
import * as Sentry from '@sentry/cloudflare'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_HISTORICAL, CACHE_CONTROL_TODAY } from '../src/cache'
import worker from '../src/index'
import { handleHistorical } from '../src/routes/historical/exact'
import { MAX_GUARDED_RECORDS, type ReadThroughUpstream, readThrough } from '../src/routes/historical/read-through'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/cloudflare')>()),
  captureException: vi.fn()
}))

vi.mock('../src/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db')>()),
  createPool: () => ({ query: async () => ({ rows: [] }), end: async () => {} })
}))

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
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
            source: 'defillama'
          }
        ]),
        String(timestamp),
        TOKEN_KEY,
        { current: vi.fn(async () => new Map()), historical: vi.fn(async () => ({ prices: [], failed: false })) }
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

  describe('read-through', () => {
    const today = normalizeToEndOfDay(Math.floor(Date.now() / 1000))
    const nowSeconds = () => Math.floor(Date.now() / 1000)
    const live = { price: 2425.5, timestamp: nowSeconds() - 20, symbol: 'WETH', confidence: 0.99 }
    const upstreamOf = (overrides: Partial<ReadThroughUpstream> = {}) =>
      ({
        current: vi.fn(async () => new Map()),
        historical: vi.fn(async () => ({ prices: [], failed: false })),
        ...overrides
      }) as ReadThroughUpstream & { current: ReturnType<typeof vi.fn>; historical: ReturnType<typeof vi.fn> }
    const currentWith = (price: typeof live | null = live) =>
      vi.fn(async () => new Map(price ? [[TOKEN_KEY, price]] : []))
    const closedWith = (price = 1800.25) =>
      vi.fn(async (targets: Array<{ chainId: number; token: string; timestamp: number }>) => ({
        prices: targets.map((target) => ({
          target,
          price: { price, timestamp: target.timestamp - 3_600, symbol: 'WETH', confidence: 0.97 }
        })),
        failed: false
      }))
    const failing = () =>
      vi.fn(async () => {
        throw new Error('DeFiLlama request failed with status 429')
      })
    const todayRequest = (source?: string) =>
      new Request(`https://svc/api/prices/historical/${today}/${TOKEN_KEY}${source ? `?source=${source}` : ''}`)
    const tableRow = (timestamp: number, price: string, source = 'defillama') => ({
      chain: 'ethereum',
      token: RAW_ADDR,
      timestamp: new Date(timestamp * 1000),
      price,
      symbol: 'WETH',
      confidence: '0.9',
      source
    })
    const lpPool = (rows: unknown[], isCurveLp: boolean): Pool =>
      ({
        query: vi.fn(async (sql: string) =>
          String(sql).includes("tp.source = 'curve'")
            ? { rows: isCurveLp ? [{ chain: 'ethereum', token: CHECKSUM_ADDR }] : [] }
            : { rows }
        )
      }) as unknown as Pool
    const insertCalls = (db: Pool) =>
      vi
        .mocked(db.query)
        .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO token_prices')) as unknown as Array<
        [string, unknown[]]
      >

    it('serves today live even when a table row exists, and persists it as provisional', async () => {
      const upstream = upstreamOf({ current: currentWith() })
      const db = pool([tableRow(today, '1')])
      const response = await handleHistorical(todayRequest(), ENV, db, String(today), TOKEN_KEY, upstream)

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
      expect(upstream.current).toHaveBeenCalledTimes(1)
      expect(upstream.current).toHaveBeenCalledWith([
        { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }
      ])
      expect(upstream.historical).not.toHaveBeenCalled()
      const [call] = insertCalls(db)
      expect(call[1]).toContain('/prices/current')
      expect(call[1]).toContain(2425.5)
      expect(call[1]).toContain(false)
      await expect(response.json()).resolves.toEqual({
        coins: {
          [TOKEN_KEY]: { price: 2425.5, symbol: 'WETH', timestamp: today, confidence: 0.99, source: 'defillama' }
        }
      })
    })

    it('serves the curve row and writes nothing when the live quote for a known Curve LP is implausible', async () => {
      const guard = vi.fn(async () => false)
      const db = lpPool([tableRow(today, '1', 'curve')], true)
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith(), guard })
      )

      expect(response.status).toBe(200)
      expect(guard).toHaveBeenCalledTimes(1)
      expect(guard).toHaveBeenCalledWith(1, CHECKSUM_ADDR, today, 2425.5)
      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1, source: 'curve' } } })
    })

    it('serves and writes the live quote for a known Curve LP when the guard accepts it', async () => {
      const guard = vi.fn(async () => true)
      const db = lpPool([tableRow(today, '1', 'curve')], true)
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith(), guard })
      )

      expect(guard).toHaveBeenCalledTimes(1)
      expect(insertCalls(db)).toHaveLength(1)
      await expect(response.json()).resolves.toMatchObject({
        coins: { [TOKEN_KEY]: { price: 2425.5, source: 'defillama' } }
      })
    })

    it('never calls the guard when the token has no curve row', async () => {
      const guard = vi.fn(async () => false)
      const db = lpPool([tableRow(today, '1')], false)
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith(), guard })
      )

      expect(guard).not.toHaveBeenCalled()
      expect(insertCalls(db)).toHaveLength(1)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 2425.5 } } })
    })

    it('does not write or serve an implausible closed-day quote for a known Curve LP and returns NOT_FOUND', async () => {
      const db = lpPool([], true)
      await expect(
        handleHistorical(
          request(),
          ENV,
          db,
          String(TIMESTAMP),
          TOKEN_KEY,
          upstreamOf({ historical: closedWith(), guard: vi.fn(async () => false) })
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(insertCalls(db)).toHaveLength(0)
    })

    it('serves today live on a table miss', async () => {
      const db = pool([])
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith() })
      )

      expect(insertCalls(db)).toHaveLength(1)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 2425.5 } } })
    })

    it('admits a stale stored today row to the bounded fallback and preserves its provenance', async () => {
      const currentFallback = vi.fn(async (targets: Array<{ chainId: number; chain: string; token: string }>) => {
        expect(targets).toEqual([{ chainId: 1, chain: 'ethereum', token: CHECKSUM_ADDR }])
        return {
          prices: new Map([
            [
              TOKEN_KEY,
              {
                price: 2401,
                timestamp: nowSeconds() - 10,
                symbol: 'WETH',
                confidence: 0.8,
                source: 'chainlink' as const,
                observationEndpoint: 'onchain.chainlink.latestRoundData'
              }
            ]
          ]),
          failed: false
        }
      })
      const db = pool([])
      const result = await readThrough(
        db,
        ENV,
        [
          { chain: 'ethereum', token: CHECKSUM_ADDR, timestamp: today },
          { chain: 'ethereum', token: CHECKSUM_ADDR, timestamp: TIMESTAMP }
        ],
        [
          {
            chain: 'ethereum',
            token: CHECKSUM_ADDR,
            timestamp: today,
            price: 1,
            symbol: 'WETH',
            confidence: 0.9,
            source: 'defillama',
            observedTimestamp: nowSeconds() - 100,
            observationEndpoint: '/prices/current'
          }
        ],
        undefined,
        upstreamOf({ current: currentWith(null), currentFallback })
      )

      expect(currentFallback).toHaveBeenCalledTimes(1)
      expect(currentFallback.mock.calls[0][0]).toHaveLength(1)
      expect(result.rows).toContainEqual(
        expect.objectContaining({
          timestamp: today,
          price: 2401,
          source: 'chainlink',
          observationEndpoint: 'onchain.chainlink.latestRoundData'
        })
      )
    })

    it('rotates the current fallback window so misses past the cap are eventually attempted', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000))
      try {
        const tokens = Array.from({ length: 9 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`)
        const currentFallback = vi.fn(async () => ({ prices: new Map(), failed: false }))
        await readThrough(
          pool([]),
          ENV,
          tokens.map((token) => ({ chain: 'ethereum', token, timestamp: today })),
          [],
          undefined,
          upstreamOf({ currentFallback })
        )
        const start = Math.floor(Date.now() / 60_000) % tokens.length
        const expected = [...tokens.slice(start), ...tokens.slice(0, start)].slice(0, 8)
        expect(currentFallback.mock.calls[0][0].map((target: { token: string }) => target.token)).toEqual(expected)
      } finally {
        vi.useRealTimers()
      }
    })

    it('replaces a stored today row when a fallback quote shares its observation time', async () => {
      const observed = nowSeconds() - 10
      const currentFallback = vi.fn(async () => ({
        prices: new Map([
          [
            TOKEN_KEY,
            {
              price: 2500,
              timestamp: observed,
              symbol: 'WETH',
              confidence: 0.8,
              source: 'derived' as const,
              observationEndpoint: 'onchain.derived'
            }
          ]
        ]),
        failed: false
      }))
      const result = await readThrough(
        pool([]),
        ENV,
        [{ chain: 'ethereum', token: CHECKSUM_ADDR, timestamp: today }],
        [
          {
            chain: 'ethereum',
            token: CHECKSUM_ADDR,
            timestamp: today,
            price: 1,
            symbol: 'WETH',
            confidence: 0.9,
            source: 'derived',
            observedTimestamp: observed,
            observationEndpoint: 'onchain.derived'
          }
        ],
        undefined,
        upstreamOf({ currentFallback })
      )
      expect(result.rows).toContainEqual(expect.objectContaining({ timestamp: today, price: 2500 }))
    })

    it('does not write or serve a derived quote for a known Curve LP that the guard rejects', async () => {
      const guard = vi.fn(async () => false)
      const currentFallback = vi.fn(async () => ({
        prices: new Map([
          [
            TOKEN_KEY,
            {
              price: 554.6,
              timestamp: nowSeconds() - 10,
              symbol: 'crvPlain3andSUSD',
              confidence: null,
              source: 'derived' as const,
              observationEndpoint: 'onchain.derived'
            }
          ]
        ]),
        failed: false
      }))
      const db = lpPool([], true)
      const result = await readThrough(
        db,
        ENV,
        [{ chain: 'ethereum', token: CHECKSUM_ADDR, timestamp: today }],
        [],
        undefined,
        upstreamOf({ currentFallback, guard })
      )

      expect(guard).toHaveBeenCalledWith(1, CHECKSUM_ADDR, today, 554.6)
      expect(result.rows).toHaveLength(0)
      expect(insertCalls(db).flatMap(([, params]) => params)).not.toContain(554.6)
    })

    it('serves the table row when live has no price for today', async () => {
      const db = pool([tableRow(today, '1')])
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith(null) })
      )

      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
    })

    it('serves the table row with a 200 when the live call throws', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const upstream = upstreamOf({ current: failing() })
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        pool([tableRow(today, '1')]),
        String(today),
        TOKEN_KEY,
        upstream
      )

      expect(upstream.current).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
      expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({
        message: 'read-through-failed',
        stage: 'current'
      })
    })

    it('returns UNAVAILABLE when the live call throws and there is no row, NOT_FOUND when live is empty', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        handleHistorical(todayRequest(), ENV, pool([]), String(today), TOKEN_KEY, upstreamOf({ current: failing() }))
      ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 })

      const upstream = upstreamOf({ current: currentWith(null) })
      await expect(
        handleHistorical(todayRequest(), ENV, pool([]), String(today), TOKEN_KEY, upstream)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(upstream.current).toHaveBeenCalledTimes(1)
    })

    it('does not call upstream for a closed day that is in the table', async () => {
      const upstream = upstreamOf({ current: currentWith(), historical: closedWith() })
      const response = await handleHistorical(
        request(),
        ENV,
        pool([tableRow(TIMESTAMP, '123.45')]),
        String(TIMESTAMP),
        TOKEN_KEY,
        upstream
      )

      expect(upstream.current).not.toHaveBeenCalled()
      expect(upstream.historical).not.toHaveBeenCalled()
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 123.45 } } })
    })

    it('fills a closed-day miss from one historical call, stores it provisional and serves the requested day', async () => {
      const upstream = upstreamOf({ historical: closedWith() })
      const db = pool([])
      const response = await handleHistorical(request(), ENV, db, String(TIMESTAMP), TOKEN_KEY, upstream)

      expect(upstream.current).not.toHaveBeenCalled()
      expect(upstream.historical).toHaveBeenCalledTimes(1)
      expect(upstream.historical).toHaveBeenCalledWith([
        { chainId: 1, token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', timestamp: TIMESTAMP }
      ])
      const [call] = insertCalls(db)
      expect(call[1]).toContain('/batchHistorical')
      expect(call[1]).toContain(1800.25)
      expect(call[1]).toContain(false)
      expect(call[1]).not.toContain(true)
      expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_HISTORICAL)
      await expect(response.json()).resolves.toEqual({
        coins: {
          [TOKEN_KEY]: { price: 1800.25, symbol: 'WETH', timestamp: TIMESTAMP, confidence: 0.97, source: 'defillama' }
        }
      })
    })

    it('finalizes a closed-day quote for a known Curve LP only after the guard accepts it', async () => {
      const guard = vi.fn(async () => true)
      const db = lpPool([], true)
      await handleHistorical(
        request(),
        ENV,
        db,
        String(TIMESTAMP),
        TOKEN_KEY,
        upstreamOf({ historical: closedWith(), guard })
      )

      expect(guard).toHaveBeenCalledTimes(1)
      const [call] = insertCalls(db)
      expect(call[1]).toContain(true)
      expect(call[1]).not.toContain(false)
    })

    it('bounds guard checks per read and drops the unchecked Curve LP quotes', async () => {
      const guard = vi.fn(async () => true)
      const days = Array.from({ length: MAX_GUARDED_RECORDS + 5 }, (_, i) => TIMESTAMP + i * 86_400)
      const result = await readThrough(
        lpPool([], true),
        ENV,
        days.map((timestamp) => ({ chain: 'ethereum', token: CHECKSUM_ADDR, timestamp })),
        [],
        undefined,
        upstreamOf({ historical: closedWith(), guard })
      )

      expect(guard).toHaveBeenCalledTimes(MAX_GUARDED_RECORDS)
      expect(result.rows.map((row) => row.timestamp)).toEqual(days.slice(0, MAX_GUARDED_RECORDS))
    })

    it('keeps a stored today row observed after the live quote', async () => {
      const db = pool([{ ...tableRow(today, '1'), observed_at: new Date((nowSeconds() - 5) * 1000) }])
      const response = await handleHistorical(
        todayRequest(),
        ENV,
        db,
        String(today),
        TOKEN_KEY,
        upstreamOf({ current: currentWith() })
      )

      expect(insertCalls(db)).toHaveLength(0)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1 } } })
    })

    it.each([
      ['today', () => today, () => todayRequest()],
      ['a closed day', () => TIMESTAMP, () => request()]
    ])(
      'returns UNAVAILABLE, not NOT_FOUND, when DeFiLlama answers %s with a malformed envelope',
      async (_, ts, req) => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        fetchMock.mockImplementation(async () => Response.json({}))
        await expect(handleHistorical(req(), ENV, pool([]), String(ts()), TOKEN_KEY)).rejects.toMatchObject({
          code: 'UNAVAILABLE'
        })
        expect(fetchMock).toHaveBeenCalled()
      }
    )

    it('reports a sustained upstream failure to Sentry once, still uncached', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } })
      fetchMock.mockImplementation(async () => new Response('slow down', { status: 429 }))
      const capture = vi.mocked(Sentry.captureException)
      capture.mockClear()
      for (let i = 0; i < 3; i++) {
        const response = await worker.fetch(
          new Request(todayRequest().url, { headers: { authorization: 'Bearer k' } }),
          { ...ENV, API_KEY_TEST: 'k' } as unknown as Env,
          { waitUntil: vi.fn() } as unknown as ExecutionContext
        )
        expect(response.status).toBe(503)
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
      expect(capture).toHaveBeenCalledTimes(1)
    })

    it('still serves the price when persisting the read-through fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('INSERT INTO token_prices')) throw new Error('db down')
          return { rows: [] }
        })
      } as unknown as Pool
      const response = await handleHistorical(
        request(),
        ENV,
        db,
        String(TIMESTAMP),
        TOKEN_KEY,
        upstreamOf({ historical: closedWith() })
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1800.25 } } })
      expect(String(error.mock.calls[0][0])).toContain('read-through-persist-failed')
    })

    it('returns NOT_FOUND for a closed-day miss when upstream has no price, UNAVAILABLE when it failed', async () => {
      const db = pool([])
      await expect(
        handleHistorical(request(), ENV, db, String(TIMESTAMP), TOKEN_KEY, upstreamOf())
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(insertCalls(db)).toHaveLength(0)

      await expect(
        handleHistorical(
          request(),
          ENV,
          pool([]),
          String(TIMESTAMP),
          TOKEN_KEY,
          upstreamOf({ historical: vi.fn(async () => ({ prices: [], failed: true })) })
        )
      ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 })
    })

    it('serves a stored closed-day row without admitting it to the repair queue', async () => {
      const db = {
        query: vi.fn(async () => ({ rows: [tableRow(TIMESTAMP, '123.45')] }))
      } as unknown as Pool

      const response = await handleHistorical(request(), ENV, db, String(TIMESTAMP), TOKEN_KEY, upstreamOf())

      expect(response.status).toBe(200)
      expect(db.query).toHaveBeenCalledTimes(1)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 123.45 } } })
      expect(
        vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('historical_price_repair_queue'))
      ).toBe(false)
    })

    it('serves a read-through price without admitting the provisional row to the repair queue', async () => {
      const db = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('tp.finalized = TRUE')) return { rows: [] }
          if (sql.includes('INSERT INTO token_prices')) return { rows: [] }
          return { rows: [] }
        })
      } as unknown as Pool

      const response = await handleHistorical(
        request(),
        ENV,
        db,
        String(TIMESTAMP),
        TOKEN_KEY,
        upstreamOf({ historical: closedWith() })
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ coins: { [TOKEN_KEY]: { price: 1800.25 } } })
      expect(
        vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('historical_price_repair_queue'))
      ).toBe(false)
    })

    it('returns UNAVAILABLE when the historical call throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await expect(
        handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY, upstreamOf({ historical: failing() }))
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    })

    it('makes no upstream call for an explicit source', async () => {
      const upstream = upstreamOf({ current: currentWith(), historical: closedWith() })
      const miss = (req: Request, ts: number) =>
        expect(handleHistorical(req, ENV, pool([]), String(ts), TOKEN_KEY, upstream)).rejects.toMatchObject({
          code: 'NOT_FOUND'
        })

      await miss(request('defillama'), TIMESTAMP)
      await miss(todayRequest('defillama'), today)
      expect(upstream.current).not.toHaveBeenCalled()
      expect(upstream.historical).not.toHaveBeenCalled()
    })
  })

  it('serves a table miss as a 404 whose negative TTL stays under the hourly warmup cadence', async () => {
    fetchMock.mockResolvedValue(Response.json({ coins: {} }))
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } })
    const response = await worker.fetch(
      new Request(request().url, { headers: { authorization: 'Bearer k' } }),
      { ...ENV, API_KEY_TEST: 'k' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=300, max-age=300')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/batchHistorical')
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
      const upstream = { current: vi.fn(), historical: vi.fn(async () => ({ prices: [], failed: false })) }
      await expect(
        handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), HYPE_KEY, upstream)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
