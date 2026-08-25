import type { Pool } from '@neondatabase/serverless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_PARTIAL } from '../src/cache'
import { getChainClient } from '../src/clients/rpc'
import { handleHistorical } from '../src/routes/historical/exact'
import type { Env } from '../src/types'
import { fakeClient } from './sources/onchain/helpers'

vi.mock('../src/clients/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/clients/rpc')>()),
  getChainClient: vi.fn()
}))

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ONCHAIN_TOKEN = '0x1111111111111111111111111111111111111111'
const UNDERLYING = '0x2222222222222222222222222222222222222222'
const TOKEN_KEY = `ethereum:${RAW_ADDR}`
const ONCHAIN_TOKEN_KEY = `ethereum:${ONCHAIN_TOKEN}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const TIMESTAMP = 1695254399
const ONCHAIN_TIMESTAMP = 1_700_006_399

function request(source?: string, timestamp = TIMESTAMP, tokenKey = TOKEN_KEY) {
  const query = source ? `?source=${source}` : ''
  return new Request(`https://svc/api/prices/historical/${timestamp}/${tokenKey}${query}`)
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
    vi.mocked(getChainClient).mockReset()
  })

  afterEach(() => {
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

  it('checks the DB before DefiLlama while resolving an on-chain underlying', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            chain: 'ethereum',
            token: UNDERLYING,
            timestamp: new Date(ONCHAIN_TIMESTAMP * 1000),
            price: '2',
            symbol: 'UNDERLYING',
            confidence: '0.9',
            source: 'defillama'
          }
        ]
      })
    vi.mocked(getChainClient).mockReturnValue(
      fakeClient({
        [ONCHAIN_TOKEN]: {
          asset: UNDERLYING,
          decimals: 18,
          convertToAssets: 10n ** 18n
        },
        [UNDERLYING]: {
          decimals: 18
        }
      })
    )
    fetchMock.mockResolvedValue(defillamaResponse(200, { coins: {} }))

    const response = await handleHistorical(
      request(undefined, ONCHAIN_TIMESTAMP, ONCHAIN_TOKEN_KEY),
      ENV,
      { query } as unknown as Pool,
      String(ONCHAIN_TIMESTAMP),
      ONCHAIN_TOKEN_KEY
    )

    expect(response.status).toBe(200)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringMatching(/insert/i))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain(`ethereum:${ONCHAIN_TOKEN}`)
    await expect(response.json()).resolves.toMatchObject({
      coins: {
        [ONCHAIN_TOKEN_KEY]: { price: 2, source: 'derived' }
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

  it('does not fall back when an explicit source is requested', async () => {
    await expect(handleHistorical(request('enso'), ENV, pool([]), String(TIMESTAMP), TOKEN_KEY)).rejects.toMatchObject({
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

    vi.useRealTimers()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
