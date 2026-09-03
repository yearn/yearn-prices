import type { Pool } from '@neondatabase/serverless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NOT_FOUND,
  CACHE_CONTROL_PARTIAL,
  CACHE_CONTROL_TODAY
} from '../src/cache'
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

  it('marks a closed-day hit immutable and a today hit short-lived', async () => {
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
        TOKEN_KEY
      )

    expect((await hit(TIMESTAMP)).headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
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

  it('serves a table miss as a 404 whose negative TTL stays under the hourly warmup cadence', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } })
    const response = await worker.fetch(
      new Request(request().url, { headers: { authorization: 'Bearer k' } }),
      { ...ENV, API_KEY_TEST: 'k' } as unknown as Env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_NOT_FOUND)
    for (const policy of [CACHE_CONTROL_NOT_FOUND, CACHE_CONTROL_PARTIAL]) {
      for (const directive of ['max-age', 's-maxage']) {
        expect(Number(policy.match(new RegExp(`${directive}=(\\d+)`))?.[1])).toBeLessThanOrEqual(3600)
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
