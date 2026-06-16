import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { handleCurrent } from '../src/routes/prices'
import { currentUtcDayEnd, normalizeToEndOfDay } from '../src/time'
import type { Env } from '../src/types'

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM = getAddress(RAW_ADDR)
const ETH_KEY = `ethereum:${RAW_ADDR}`
const BASE_KEY = `base:${RAW_ADDR}`
const ENV: Env = { DATABASE_URL: 'postgres://x', ENSO_API_KEY: 'enso-key' }

function ensoRes(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    decimals: 8,
    price: 27052,
    address: RAW_ADDR,
    chainId: 1,
    symbol: 'WBTC',
    timestamp: 1695197412,
    confidence: 0.99,
    ...overrides,
  }
}

function fakePool() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() } as any
}

function currentRequest(coins: unknown) {
  return new Request(`https://svc/api/prices/current?coins=${encodeURIComponent(JSON.stringify(coins))}`)
}

describe('handleCurrent', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('proxies Enso, persists, and returns the batched coins shape', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))
    const pool = fakePool()

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, pool)

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(Object.keys(body.coins)).toEqual([ETH_KEY])
    expect(body.coins[ETH_KEY]).toEqual({
      symbol: 'WBTC',
      prices: [
        {
          timestamp: normalizeToEndOfDay(1695197412),
          price: 27052,
          confidence: 0.99,
          source: 'enso',
        },
      ],
    })
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('fetches, returns, and persists multiple tokens in one request', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/prices/1/')) return Promise.resolve(ensoRes(200, okBody({ price: 100, symbol: 'A' })))
      if (url.includes('/api/v1/prices/8453/')) return Promise.resolve(ensoRes(200, okBody({ price: 200, symbol: 'B' })))
      throw new Error(`unexpected url ${url}`)
    })
    const pool = fakePool()

    const response = await handleCurrent(currentRequest([ETH_KEY, BASE_KEY]), ENV, pool)
    const body = (await response.json()) as any

    expect(Object.keys(body.coins).sort()).toEqual([BASE_KEY, ETH_KEY].sort())
    expect(body.coins[ETH_KEY].prices[0].price).toBe(100)
    expect(body.coins[BASE_KEY].prices[0].price).toBe(200)

    // Both rows persisted in a single insert (all today => one mutable batch).
    expect(pool.query).toHaveBeenCalledTimes(1)
    const params = pool.query.mock.calls[0][1] as unknown[]
    expect(params).toContain('ethereum')
    expect(params).toContain('base')
    expect(params.filter(value => value === 100 || value === 200)).toEqual([100, 200])
  })

  it('omits tokens Enso has no price for, persists only the winners', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/prices/1/')) return Promise.resolve(ensoRes(200, okBody({ price: 100 })))
      if (url.includes('/api/v1/prices/8453/')) return Promise.resolve(ensoRes(404, {}))
      throw new Error(`unexpected url ${url}`)
    })
    const pool = fakePool()

    const response = await handleCurrent(currentRequest([ETH_KEY, BASE_KEY]), ENV, pool)
    const body = (await response.json()) as any

    expect(Object.keys(body.coins)).toEqual([ETH_KEY])

    // Only the resolved ethereum token is written; the 404 base token is not.
    expect(pool.query).toHaveBeenCalledTimes(1)
    const params = pool.query.mock.calls[0][1] as unknown[]
    expect(params).toContain('ethereum')
    expect(params).not.toContain('base')
  })

  it('returns empty coins and a revalidating cache header when every token fails', async () => {
    fetchMock.mockResolvedValue(ensoRes(404, {}))
    const pool = fakePool()

    const response = await handleCurrent(currentRequest([ETH_KEY, BASE_KEY]), ENV, pool)
    const body = (await response.json()) as any

    expect(body.coins).toEqual({})
    expect(pool.query).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=14400')
  })

  it('dedupes token keys that normalize to the same value', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))
    const pool = fakePool()

    await handleCurrent(currentRequest([ETH_KEY, `ethereum:${CHECKSUM}`]), ENV, pool)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends a lowercase address to Enso but writes the checksummed address to the DB', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))
    const pool = fakePool()

    await handleCurrent(currentRequest([`ethereum:${CHECKSUM}`]), ENV, pool)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.enso.build/api/v1/prices/1/${RAW_ADDR}`)
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer enso-key' })

    const params = pool.query.mock.calls[0][1] as unknown[]
    expect(params).toContain(CHECKSUM)
    expect(params).toContain('ethereum')
    expect(params).toContain('enso')
    expect(params).not.toContain(RAW_ADDR)
  })

  it('defaults missing symbol and confidence to null', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ symbol: undefined, confidence: undefined })))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())
    const body = (await response.json()) as any

    expect(body.coins[ETH_KEY].symbol).toBeNull()
    expect(body.coins[ETH_KEY].prices[0].confidence).toBeNull()
  })

  it('sets the today cache-control header', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: 0 })))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())

    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=14400')
  })

  it('converts Enso millisecond timestamps to the correct UTC day', async () => {
    const ms = 1781549905855 // 13-digit ms, as the live Enso API returns
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: ms })))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())
    const body = (await response.json()) as any

    expect(body.coins[ETH_KEY].prices[0].timestamp).toBe(normalizeToEndOfDay(Math.floor(ms / 1000)))
  })

  it('falls back to today end-of-day when Enso timestamp is zero', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: 0 })))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())
    const body = (await response.json()) as any

    expect(body.coins[ETH_KEY].prices[0].timestamp).toBe(currentUtcDayEnd())
  })

  it('still returns prices when persistence fails (best-effort)', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: 42 })))
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')), end: vi.fn() } as any
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, pool)

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.coins[ETH_KEY].prices[0].price).toBe(42)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('omits a token when Enso reports a zero price', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: 0 })))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())
    const body = (await response.json()) as any

    expect(body.coins).toEqual({})
  })

  it('omits a token when Enso returns a 404', async () => {
    fetchMock.mockResolvedValue(ensoRes(404, {}))

    const response = await handleCurrent(currentRequest([ETH_KEY]), ENV, fakePool())
    const body = (await response.json()) as any

    expect(body.coins).toEqual({})
  })

  it('throws INTERNAL_ERROR when ENSO_API_KEY is not configured', async () => {
    await expect(
      handleCurrent(currentRequest([ETH_KEY]), { DATABASE_URL: 'x' } as Env, fakePool()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a missing coins parameter with INVALID_INPUT', async () => {
    await expect(
      handleCurrent(new Request('https://svc/api/prices/current'), ENV, fakePool()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-array coins payload with INVALID_INPUT', async () => {
    await expect(
      handleCurrent(currentRequest({ [ETH_KEY]: [] }), ENV, fakePool()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported chain in a token key with INVALID_INPUT', async () => {
    await expect(
      handleCurrent(currentRequest([`fakechain:${RAW_ADDR}`]), ENV, fakePool()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed token address with INVALID_INPUT', async () => {
    await expect(
      handleCurrent(currentRequest(['ethereum:0xnothex']), ENV, fakePool()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
