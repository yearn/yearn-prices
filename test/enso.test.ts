import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlidingWindowRateLimiter } from '../src/defillama'
import { EnsoClient } from '../src/enso'

const ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const OK_BODY = {
  decimals: 8,
  price: 27052,
  address: ADDR,
  chainId: 1,
  symbol: 'WBTC',
  timestamp: 1695197412,
  confidence: 0.99,
}

function res(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function newClient(onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void): EnsoClient {
  // Fresh limiter per client so tests never contend on the module-level shared one.
  return new EnsoClient('secret-key', new SlidingWindowRateLimiter(10, 1000), onRetry)
}

describe('EnsoClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('GETs the Enso price endpoint with bearer auth and returns the body', async () => {
    fetchMock.mockResolvedValue(res(200, OK_BODY))

    const data = await newClient().getPrice(1, ADDR)

    expect(data).toEqual(OK_BODY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.enso.build/api/v1/prices/1/${ADDR}`)
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer secret-key' })
  })

  it('never leaks the api key into the request url', async () => {
    fetchMock.mockResolvedValue(res(200, OK_BODY))

    await newClient().getPrice(1, ADDR)

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-key')
  })

  it('maps a 404 to a NOT_FOUND ApiError without retrying', async () => {
    fetchMock.mockResolvedValue(res(404, {}))

    await expect(newClient().getPrice(1, ADDR)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a non-retryable 4xx to INTERNAL_ERROR without retrying', async () => {
    fetchMock.mockResolvedValue(res(400, {}))

    await expect(newClient().getPrice(1, ADDR)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx then succeeds', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(res(500, {})).mockResolvedValueOnce(res(200, OK_BODY))
    const onRetry = vi.fn()

    const promise = newClient(onRetry).getPrice(1, ADDR)
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toEqual(OK_BODY)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives up with INTERNAL_ERROR after exhausting retries on persistent 5xx', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(res(503, {}))

    const promise = newClient().getPrice(1, ADDR)
    const expectation = expect(promise).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await vi.runAllTimersAsync()

    await expectation
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
