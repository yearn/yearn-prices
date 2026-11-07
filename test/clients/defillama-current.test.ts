import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefiLlamaClient } from '../../src/clients/defillama'
import {
  CURRENT_MAX_AGE_SECONDS,
  CURRENT_MAX_FUTURE_SKEW_SECONDS,
  DEFI_LLAMA_CURRENT_BATCH,
  fetchCurrentPrices
} from '../../src/sources/defillama/current'

const WETH = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const OTHER = 'ethereum:0x0000000000000000000000000000000000000001'
const NOW = Math.floor(Date.now() / 1000)

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DefiLlamaClient.getCurrent', () => {
  it('requests /prices/current with the joined coins', async () => {
    const fetchMock = stubFetch({ coins: {} })

    await new DefiLlamaClient().getCurrent([WETH, OTHER])

    expect(String(fetchMock.mock.calls[0][0] as unknown as string)).toBe(
      `https://coins.llama.fi/prices/current/${WETH},${OTHER}`
    )
  })

  it('passes an optional abort signal to /prices/current', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          resolveStarted()
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true })
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = new DefiLlamaClient().getCurrent([WETH], controller.signal)
    await started
    expect(requestSignal).toBeDefined()

    controller.abort()
    expect(requestSignal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('fetchCurrentPrices', () => {
  const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

  it('maps usable coins, omits unknown or invalid ones, and skips unsupported chains', async () => {
    const fetchMock = stubFetch({
      coins: {
        [WETH]: { price: 2391.41, symbol: 'WETH', timestamp: NOW - 60, confidence: 0.99 },
        [OTHER]: { price: 0, symbol: 'X', timestamp: NOW - 60 }
      }
    })

    const prices = await fetchCurrentPrices(new DefiLlamaClient(), [
      { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
      { chain: 'ethereum', token: '0x0000000000000000000000000000000000000001' },
      { chain: 'robinhood', token: '0x0000000000000000000000000000000000000002' }
    ])

    expect([...prices.keys()]).toEqual([WETH])
    expect(prices.get(WETH)).toEqual({ price: 2391.41, timestamp: NOW - 60, symbol: 'WETH', confidence: 0.99 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0] as unknown as string)).not.toContain('robinhood')
  })

  it('omits quotes older than the max age or further in the future than the skew allowance', async () => {
    const coin = (n: number) => `ethereum:${token(n)}`
    stubFetch({
      coins: {
        [coin(1)]: { price: 1, timestamp: NOW - CURRENT_MAX_AGE_SECONDS + 60 },
        [coin(2)]: { price: 1, timestamp: NOW - 7 * 86_400 },
        [coin(3)]: { price: 1, timestamp: NOW + CURRENT_MAX_FUTURE_SKEW_SECONDS + 60 }
      }
    })

    const prices = await fetchCurrentPrices(
      new DefiLlamaClient(),
      [1, 2, 3].map((n) => ({ chain: 'ethereum', token: token(n) }))
    )

    expect([...prices.keys()]).toEqual([coin(1)])
  })

  it.each([{}, { coins: null }, { coins: [] }, null])(
    'rejects malformed envelope %j instead of a miss',
    async (body) => {
      stubFetch(body)
      await expect(
        fetchCurrentPrices(new DefiLlamaClient(), [{ chain: 'ethereum', token: token(1) }])
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    }
  )

  it('dedupes and splits requests into batches', async () => {
    const fetchMock = stubFetch({ coins: {} })
    const targets = Array.from({ length: DEFI_LLAMA_CURRENT_BATCH + 1 }, (_, i) => ({
      chain: 'ethereum',
      token: token(i + 1)
    }))

    await fetchCurrentPrices(new DefiLlamaClient(), [...targets, targets[0]])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
