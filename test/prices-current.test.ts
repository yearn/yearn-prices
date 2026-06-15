import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { handleCurrent } from '../src/routes/prices'
import { currentUtcDayEnd, normalizeToEndOfDay } from '../src/time'
import type { Env } from '../src/types'

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM = getAddress(RAW_ADDR)
const KEY = `ethereum:${CHECKSUM}`
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

  it('proxies Enso, persists, and returns the coins shape', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))
    const pool = fakePool()

    const response = await handleCurrent(ENV, pool, '1', RAW_ADDR)

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(Object.keys(body.coins)).toEqual([KEY])
    expect(body.coins[KEY]).toEqual({
      price: 27052,
      symbol: 'WBTC',
      timestamp: normalizeToEndOfDay(1695197412),
      confidence: 0.99,
      source: 'enso',
    })
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('sends a lowercase address to Enso but writes the checksummed address to the DB', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))
    const pool = fakePool()

    await handleCurrent(ENV, pool, '1', RAW_ADDR)

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

    const response = await handleCurrent(ENV, fakePool(), '1', RAW_ADDR)
    const body = (await response.json()) as any

    expect(body.coins[KEY].symbol).toBeNull()
    expect(body.coins[KEY].confidence).toBeNull()
  })

  it('sets the today cache-control header', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: 0 })))

    const response = await handleCurrent(ENV, fakePool(), '1', RAW_ADDR)

    expect(response.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=14400')
  })

  it('converts Enso millisecond timestamps to the correct UTC day', async () => {
    const ms = 1781549905855 // 13-digit ms, as the live Enso API returns
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: ms })))

    const response = await handleCurrent(ENV, fakePool(), '1', RAW_ADDR)
    const body = (await response.json()) as any

    expect(body.coins[KEY].timestamp).toBe(normalizeToEndOfDay(Math.floor(ms / 1000)))
  })

  it('falls back to today end-of-day when Enso timestamp is zero', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: 0 })))

    const response = await handleCurrent(ENV, fakePool(), '1', RAW_ADDR)
    const body = (await response.json()) as any

    expect(body.coins[KEY].timestamp).toBe(currentUtcDayEnd())
  })

  it('still returns the price when persistence fails (best-effort)', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: 42 })))
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')), end: vi.fn() } as any
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleCurrent(ENV, pool, '1', RAW_ADDR)

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.coins[KEY].price).toBe(42)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('throws INTERNAL_ERROR when ENSO_API_KEY is not configured', async () => {
    await expect(
      handleCurrent({ DATABASE_URL: 'x' } as Env, fakePool(), '1', RAW_ADDR),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric chain id with INVALID_INPUT', async () => {
    await expect(handleCurrent(ENV, fakePool(), 'abc', RAW_ADDR)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported chain id with INVALID_INPUT', async () => {
    await expect(handleCurrent(ENV, fakePool(), '999', RAW_ADDR)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed token address with INVALID_INPUT', async () => {
    await expect(handleCurrent(ENV, fakePool(), '1', '0xnothex')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns NOT_FOUND when Enso reports a zero price', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: 0 })))
    await expect(handleCurrent(ENV, fakePool(), '1', RAW_ADDR)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns NOT_FOUND when Enso omits the price', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: undefined })))
    await expect(handleCurrent(ENV, fakePool(), '1', RAW_ADDR)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('maps an Enso 404 to NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(ensoRes(404, {}))
    await expect(handleCurrent(ENV, fakePool(), '1', RAW_ADDR)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
