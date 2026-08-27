import type { Pool } from '@neondatabase/serverless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_PARTIAL } from '../src/cache'
import { handleHistorical } from '../src/routes/historical/exact'
import type { Env } from '../src/types'

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

function defillamaResponse(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('handleHistorical', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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

  it('uses DefiLlama when the DB misses', async () => {
    fetchMock.mockResolvedValue(
      defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: {
            price: 27052,
            symbol: 'WBTC',
            timestamp: TIMESTAMP,
            confidence: 0.99
          }
        }
      })
    )

    const response = await handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toEqual({
      coins: {
        [TOKEN_KEY]: {
          price: 27052,
          symbol: 'WBTC',
          timestamp: TIMESTAMP,
          confidence: 0.99,
          source: 'defillama'
        }
      }
    })
  })

  it('serves a fallback with a short TTL while a past-day DB hit stays immutable', async () => {
    fetchMock.mockResolvedValue(
      defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: {
            price: 27052,
            symbol: 'WBTC',
            timestamp: TIMESTAMP,
            confidence: 0.99
          }
        }
      })
    )

    const fallback = await handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)
    expect(fallback.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)

    const hit = await handleHistorical(
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
    expect(hit.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('reports the normalized day-end when DefiLlama returns a different timestamp', async () => {
    fetchMock.mockResolvedValue(
      defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: {
            price: 27052,
            symbol: 'WBTC',
            timestamp: TIMESTAMP + 7200,
            confidence: 0.99
          }
        }
      })
    )

    const response = await handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)

    await expect(response.json()).resolves.toEqual({
      coins: {
        [TOKEN_KEY]: {
          price: 27052,
          symbol: 'WBTC',
          timestamp: TIMESTAMP,
          confidence: 0.99,
          source: 'defillama'
        }
      }
    })
  })

  it('resolves current-day requests at now, not the future end-of-day', async () => {
    const now = 1787911200
    vi.useFakeTimers()
    vi.setSystemTime(now * 1000)

    fetchMock.mockResolvedValue(
      defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: {
            price: 27052,
            symbol: 'WBTC',
            timestamp: now,
            confidence: 0.99
          }
        }
      })
    )

    const response = await handleHistorical(request(), ENV, pool([]), String(now - 600), TOKEN_KEY)

    expect(response.status).toBe(200)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain(`/prices/historical/${now}/`)
  })

  // The incident's worst hour: right after utc midnight the normalized end-of-day is
  // ~24h in the future, so DeFiLlama's 6h search window holds no data yet. The mock
  // answers only for timestamps that have happened — pre-clamp code 404s here.
  it('resolves right after utc midnight, when end-of-day is a day away', async () => {
    const dayStart = 1787875200
    const now = dayStart + 300
    vi.useFakeTimers()
    vi.setSystemTime(now * 1000)

    fetchMock.mockImplementation(async (rawUrl: unknown) => {
      const requested = Number(String(rawUrl).match(/\/prices\/historical\/(\d+)\//)?.[1])
      if (requested > now) return defillamaResponse(200, { coins: {} })
      return defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: { price: 27052, symbol: 'WBTC', timestamp: requested, confidence: 0.99 }
        }
      })
    })

    const response = await handleHistorical(request(), ENV, pool([]), String(dayStart + 60), TOKEN_KEY)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      coins: { [TOKEN_KEY]: { price: 27052 } }
    })
  })

  it('still resolves past days at their normalized end-of-day', async () => {
    fetchMock.mockResolvedValue(
      defillamaResponse(200, {
        coins: {
          [`ethereum:${RAW_ADDR}`]: { price: 27052, symbol: 'WBTC', timestamp: TIMESTAMP, confidence: 0.99 }
        }
      })
    )

    const response = await handleHistorical(request(), ENV, pool([]), String(TIMESTAMP - 7200), TOKEN_KEY)

    expect(response.status).toBe(200)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain(`/prices/historical/${TIMESTAMP}/`)
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

  it('returns NOT_FOUND when both DB and the fallback miss', async () => {
    fetchMock.mockResolvedValue(defillamaResponse(200, { coins: {} }))

    await expect(handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  // A degraded upstream must not be folded into NOT_FOUND: that response is served
  // with CACHE_CONTROL_NOT_FOUND (public, max-age=3600), so a blip would cache a
  // false 404 for an hour. It propagates as a retryable INTERNAL_ERROR instead.
  it('propagates a DefiLlama 5xx as INTERNAL_ERROR rather than NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(defillamaResponse(503))
    vi.useFakeTimers()

    const assertion = expect(
      handleHistorical(request(), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await vi.runAllTimersAsync()
    await assertion

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
