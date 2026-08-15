import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorEnvelope } from '../src/http'
import { handleSpot } from '../src/routes/spot'
import type { Env } from '../src/types'
import { toUnixSeconds } from '../src/utils'

const SPOT_NOT_FOUND = errorEnvelope('NOT_FOUND', 'No price available for this token')
const SPOT_UNAVAILABLE = errorEnvelope('UNAVAILABLE', 'Price temporarily unavailable, please retry')

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM = getAddress(RAW_ADDR)
const ETH_KEY = `ethereum:${RAW_ADDR}`
const BASE_KEY = `base:${RAW_ADDR}`
const ENV: Env = { DATABASE_URL: 'postgres://x', ENSO_API_KEY: 'enso-key' }
const SPOT_CACHE_CONTROL = 'public, s-maxage=120, stale-while-revalidate=600'

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
    ...overrides
  }
}

function spotRequest(coins: unknown) {
  return new Request(`https://svc/api/prices/spot?coins=${encodeURIComponent(JSON.stringify(coins))}`)
}

import { resetSpotSourceRegistry } from '../src/registries'

describe('handleSpot', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetSpotSourceRegistry()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('proxies Enso and returns the batched coins shape', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(Object.keys(body.coins)).toEqual([ETH_KEY])
    expect(body.coins[ETH_KEY]).toEqual({
      symbol: 'WBTC',
      prices: [
        {
          timestamp: 1695197412,
          price: 27052,
          confidence: 0.99,
          source: 'enso'
        }
      ]
    })
  })

  it('fetches and returns multiple tokens in one request', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/prices/1/')) return Promise.resolve(ensoRes(200, okBody({ price: 100, symbol: 'A' })))
      if (url.includes('/api/v1/prices/8453/'))
        return Promise.resolve(ensoRes(200, okBody({ price: 200, symbol: 'B' })))
      throw new Error(`unexpected url ${url}`)
    })

    const response = await handleSpot(spotRequest([ETH_KEY, BASE_KEY]), ENV)
    const body = (await response.json()) as any

    expect(Object.keys(body.coins).sort()).toEqual([BASE_KEY, ETH_KEY].sort())
    expect(body.coins[ETH_KEY].prices[0].price).toBe(100)
    expect(body.coins[BASE_KEY].prices[0].price).toBe(200)
  })

  it('returns a friendly per-token error when Enso has no price', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v1/prices/1/')) return Promise.resolve(ensoRes(200, okBody({ price: 100 })))
      if (url.includes('/api/v1/prices/8453/')) return Promise.resolve(ensoRes(404, {}))
      throw new Error(`unexpected url ${url}`)
    })

    const response = await handleSpot(spotRequest([ETH_KEY, BASE_KEY]), ENV)
    const body = (await response.json()) as any

    expect(Object.keys(body.coins).sort()).toEqual([BASE_KEY, ETH_KEY].sort())
    expect(body.coins[BASE_KEY]).toEqual(SPOT_NOT_FOUND)
  })

  it('returns an error for every token and the spot cache header when every token fails', async () => {
    fetchMock.mockResolvedValue(ensoRes(404, {}))

    const response = await handleSpot(spotRequest([ETH_KEY, BASE_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins).toEqual({
      [ETH_KEY]: SPOT_NOT_FOUND,
      [BASE_KEY]: SPOT_NOT_FOUND
    })
    expect(response.headers.get('cache-control')).toBe(SPOT_CACHE_CONTROL)
  })

  it('marks upstream failures as retryable', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins).toEqual({
      [ETH_KEY]: SPOT_UNAVAILABLE
    })
  })

  it('dedupes token keys that normalize to the same value', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))

    await handleSpot(spotRequest([ETH_KEY, `ethereum:${CHECKSUM}`]), ENV)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends a lowercase address to Enso with bearer auth', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))

    await handleSpot(spotRequest([`ethereum:${CHECKSUM}`]), ENV)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.enso.build/api/v1/prices/1/${RAW_ADDR}`)
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer enso-key' })
  })

  it('defaults missing symbol and confidence to null', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ symbol: undefined, confidence: undefined })))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins[ETH_KEY].symbol).toBeNull()
    expect(body.coins[ETH_KEY].prices[0].confidence).toBeNull()
  })

  it('sets the spot cache-control header', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody()))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)

    expect(response.headers.get('cache-control')).toBe(SPOT_CACHE_CONTROL)
  })

  it('converts Enso millisecond timestamps to seconds without day-end normalization', async () => {
    const ms = 1781549905855 // 13-digit ms, as the live Enso API returns
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: ms })))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins[ETH_KEY].prices[0].timestamp).toBe(toUnixSeconds(ms))
    expect(body.coins[ETH_KEY].prices[0].timestamp).toBe(Math.floor(ms / 1000))
  })

  it('falls back to the current time when Enso omits the timestamp', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ timestamp: 0 })))

    const before = Math.floor(Date.now() / 1000)
    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any
    const after = Math.floor(Date.now() / 1000)

    const ts = body.coins[ETH_KEY].prices[0].timestamp
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 1)
  })

  it('returns an error when Enso reports a zero price', async () => {
    fetchMock.mockResolvedValue(ensoRes(200, okBody({ price: 0 })))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins).toEqual({
      [ETH_KEY]: SPOT_NOT_FOUND
    })
  })

  it('returns an error when Enso returns a 404', async () => {
    fetchMock.mockResolvedValue(ensoRes(404, {}))

    const response = await handleSpot(spotRequest([ETH_KEY]), ENV)
    const body = (await response.json()) as any

    expect(body.coins).toEqual({
      [ETH_KEY]: SPOT_NOT_FOUND
    })
  })

  it('throws INTERNAL_ERROR when ENSO_API_KEY is not configured', async () => {
    await expect(handleSpot(spotRequest([ETH_KEY]), { DATABASE_URL: 'x' } as Env)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a missing coins parameter with INVALID_INPUT', async () => {
    await expect(handleSpot(new Request('https://svc/api/prices/spot'), ENV)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-array coins payload with INVALID_INPUT', async () => {
    await expect(handleSpot(spotRequest({ [ETH_KEY]: [] }), ENV)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported chain in a token key with INVALID_INPUT', async () => {
    await expect(handleSpot(spotRequest([`fakechain:${RAW_ADDR}`]), ENV)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed token address with INVALID_INPUT', async () => {
    await expect(handleSpot(spotRequest(['ethereum:0xnothex']), ENV)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
