import type { PublicClient } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedCooldownRateLimiter } from '../../../src/clients/http-client'
import { ApiError } from '../../../src/http/errors'
import {
  BOBS_MAX_OBSERVATION_AGE_SECONDS,
  type BobsHistoricalSourceOptions,
  createBobsHistoricalSource,
  createOptionalBobsHistoricalSource
} from '../../../src/sources/bobs/historical'

const CHAIN = 910_901
const TOKEN = '0x00000000000000000000000000000000000000aa'
const BASE_TIMESTAMP = 1_700_000_000

function response(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body
  } as unknown as Response
}

function rpcClient(): PublicClient {
  return {
    async getBlock(args?: { blockNumber?: bigint }) {
      const number = args?.blockNumber ?? 100n
      return { number, timestamp: BigInt(BASE_TIMESTAMP + Number(number)) }
    }
  } as unknown as PublicClient
}

function source(fetchImpl: typeof fetch, overrides: Partial<BobsHistoricalSourceOptions> = {}) {
  return createBobsHistoricalSource({
    signer: `signer-${Math.random()}`,
    signature: 'signature',
    baseUrl: 'https://bobs.test',
    clientForChain: () => rpcClient(),
    fetchImpl,
    timeoutMs: 0,
    ...overrides
  })
}

describe('BobsHistoricalSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is disabled when credentials are incomplete', () => {
    const disabled = createBobsHistoricalSource({
      baseUrl: 'https://bobs.test',
      clientForChain: () => rpcClient(),
      signer: 'only-one-credential'
    })

    expect(disabled.supports(CHAIN)).toBe(false)
  })

  it('treats an explicit environment as authoritative over process.env', () => {
    const previousSigner = process.env.YPRICEAPI_SIGNER
    const previousSignature = process.env.YPRICEAPI_SIGNATURE
    process.env.YPRICEAPI_SIGNER = 'process-signer'
    process.env.YPRICEAPI_SIGNATURE = 'process-signature'
    try {
      expect(createOptionalBobsHistoricalSource({ DATABASE_URL: 'postgres://test' })).toBeNull()
    } finally {
      if (previousSigner === undefined) delete process.env.YPRICEAPI_SIGNER
      else process.env.YPRICEAPI_SIGNER = previousSigner
      if (previousSignature === undefined) delete process.env.YPRICEAPI_SIGNATURE
      else process.env.YPRICEAPI_SIGNATURE = previousSignature
    }
  })

  it('resolves a timestamp to a pinned block and preserves its timestamp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))
      .mockResolvedValueOnce(response(200, '123.45'))
    const result = await source(fetchMock).getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)

    expect(result).toEqual({
      price: 123.45,
      timestamp: BASE_TIMESTAMP + 50,
      symbol: null,
      confidence: null,
      evidence: {
        blockNumber: 50,
        blockTimestamp: BASE_TIMESTAMP + 50,
        observationEndpoint: '/get_price'
      }
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain(`/get_price/${CHAIN}/${TOKEN}?block=50`)
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      'X-Signer': expect.any(String),
      'X-Signature': 'signature'
    })
  })

  it('accepts a positive numeric response and caches the exact block result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))
      .mockResolvedValueOnce(response(200, 2.5))
    const instance = source(fetchMock)

    await expect(instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)).resolves.toMatchObject({ price: 2.5 })
    await expect(instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)).resolves.toMatchObject({ price: 2.5 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent chain and price requests', async () => {
    const fetchMock = vi.fn()
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    fetchMock.mockReturnValueOnce(pending).mockResolvedValueOnce(response(200, 7))
    const instance = source(fetchMock)
    const first = instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)
    const second = instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)
    release(response(200, { [CHAIN]: 'Test chain' }))

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        price: 7,
        timestamp: BASE_TIMESTAMP + 50,
        evidence: {
          blockNumber: 50,
          blockTimestamp: BASE_TIMESTAMP + 50,
          observationEndpoint: '/get_price'
        }
      }),
      expect.objectContaining({
        price: 7,
        timestamp: BASE_TIMESTAMP + 50,
        evidence: {
          blockNumber: 50,
          blockTimestamp: BASE_TIMESTAMP + 50,
          observationEndpoint: '/get_price'
        }
      })
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not negative-cache a 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, 4))
    const instance = source(fetchMock)

    await expect(instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)).resolves.toBeNull()
    await expect(instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)).resolves.toMatchObject({ price: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([429, 503, 200])('surfaces %s or malformed responses as UNAVAILABLE', async (status) => {
    const body = status === 200 ? { bad: true } : undefined
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))
      .mockResolvedValueOnce(response(status, body, status === 429 ? { 'retry-after': '0' } : undefined))

    await expect(source(fetchMock).getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })
  })

  it('rejects a block older than the observation window', async () => {
    const oldClient = {
      async getBlock(args?: { blockNumber?: bigint }) {
        const number = args?.blockNumber ?? 100n
        return { number, timestamp: BigInt(BASE_TIMESTAMP - BOBS_MAX_OBSERVATION_AGE_SECONDS - 1) }
      }
    } as unknown as PublicClient
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))

    await expect(
      source(fetchMock, { clientForChain: () => oldClient }).getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP)
    ).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors a shared retry-after cooldown after a rate limit', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, { [CHAIN]: 'Test chain' }))
      .mockResolvedValueOnce(response(429, undefined, { 'retry-after': '2' }))
    const instance = source(fetchMock, { rateLimiter: new SharedCooldownRateLimiter(10, 1_000, 3_000) })

    const first = instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)
    await expect(first).rejects.toBeInstanceOf(ApiError)
    const second = instance.getHistoricalPrice(CHAIN, TOKEN, BASE_TIMESTAMP + 50)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    fetchMock.mockResolvedValueOnce(response(200, 8))
    await expect(second).resolves.toMatchObject({ price: 8 })
    vi.useRealTimers()
  })
})
