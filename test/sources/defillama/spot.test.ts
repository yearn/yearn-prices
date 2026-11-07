import { describe, expect, it, vi } from 'vitest'
import type { DefiLlamaClient } from '../../../src/clients/defillama'
import { CURRENT_MAX_AGE_SECONDS, CURRENT_MAX_FUTURE_SKEW_SECONDS } from '../../../src/sources/defillama/current'
import { createDefiLlamaSpotSource, DEFI_LLAMA_SPOT_BATCH } from '../../../src/sources/defillama/spot'

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const OTHER = '0x0000000000000000000000000000000000000001'
const NOW = Math.floor(Date.now() / 1000)

describe('createDefiLlamaSpotSource', () => {
  it('maps a valid current response', async () => {
    const getCurrent = vi.fn(async () => ({
      coins: {
        [`ethereum:${WETH}`]: {
          price: 2_391.41,
          symbol: 'WETH',
          timestamp: NOW - 60,
          confidence: 0.99
        }
      }
    }))
    const source = createDefiLlamaSpotSource({ getCurrent })

    await expect(source.getSpotPrice(1, WETH.toUpperCase())).resolves.toEqual({
      price: 2_391.41,
      timestamp: NOW - 60,
      symbol: 'WETH',
      confidence: 0.99
    })
    expect(getCurrent).toHaveBeenCalledWith([`ethereum:${WETH}`], expect.any(AbortSignal))
  })

  it('returns null for a successful empty response and does not retry the key', async () => {
    const getCurrent = vi.fn(async () => ({ coins: {} }))
    const source = createDefiLlamaSpotSource({ getCurrent })

    await expect(source.getSpotPrice(1, WETH)).resolves.toBeNull()
    expect(getCurrent).toHaveBeenCalledTimes(1)
  })

  it('propagates a malformed response as a provider failure', async () => {
    const getCurrentMock = vi.fn(async () => ({ coins: null }))
    const source = createDefiLlamaSpotSource({
      getCurrent: getCurrentMock as unknown as DefiLlamaClient['getCurrent']
    })

    await expect(source.getSpotPrice(1, WETH)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('rejects stale and future observations as misses', async () => {
    const getCurrent = vi.fn(async () => ({
      coins: {
        [`ethereum:${WETH}`]: { price: 1, timestamp: NOW - CURRENT_MAX_AGE_SECONDS - 1 },
        [`ethereum:${OTHER}`]: { price: 1, timestamp: NOW + CURRENT_MAX_FUTURE_SKEW_SECONDS + 1 }
      }
    }))
    const source = createDefiLlamaSpotSource({ getCurrent })

    await expect(source.getSpotPrice(1, WETH)).resolves.toBeNull()
    await expect(source.getSpotPrice(1, OTHER)).resolves.toBeNull()
  })

  it('coalesces concurrent lookups and splits large batches', async () => {
    const tokens = Array.from(
      { length: DEFI_LLAMA_SPOT_BATCH + 1 },
      (_, index) => `0x${String(index + 1).padStart(40, '0')}`
    )
    const getCurrent = vi.fn(async (keys: string[]) => ({
      coins: Object.fromEntries(keys.map((key) => [key, { price: 1, timestamp: NOW }]))
    }))
    const source = createDefiLlamaSpotSource({ getCurrent })

    const results = await Promise.all([
      ...tokens.map((token) => source.getSpotPrice(1, token)),
      source.getSpotPrice(1, tokens[0])
    ])

    expect(results).toHaveLength(tokens.length + 1)
    expect(results.every((result) => result?.price === 1)).toBe(true)
    expect(getCurrent).toHaveBeenCalledTimes(2)
    expect(new Set(getCurrent.mock.calls.flatMap(([keys]) => keys as string[])).size).toBe(tokens.length)
  })

  it('propagates one failed batch to all members without issuing per-token retries', async () => {
    const failure = new Error('provider unavailable')
    const getCurrent = vi.fn().mockRejectedValue(failure)
    const source = createDefiLlamaSpotSource({ getCurrent })

    const results = await Promise.allSettled([source.getSpotPrice(1, WETH), source.getSpotPrice(1, OTHER)])

    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(getCurrent).toHaveBeenCalledTimes(1)
  })

  it('remembers a failed key for the lifetime of the request source', async () => {
    const failure = new Error('provider unavailable')
    const getCurrent = vi.fn().mockRejectedValue(failure)
    const source = createDefiLlamaSpotSource({ getCurrent })

    await expect(source.getSpotPrice(1, WETH)).rejects.toBe(failure)
    await expect(source.getSpotPrice(1, WETH)).rejects.toBe(failure)
    expect(getCurrent).toHaveBeenCalledTimes(1)
  })

  it('cancels one waiter without aborting a batch needed by a sibling', async () => {
    vi.useFakeTimers()
    try {
      let resolveResponse!: (value: unknown) => void
      const getCurrentMock = vi.fn((_keys: string[], signal?: AbortSignal) => {
        expect(signal?.aborted).toBe(false)
        return new Promise((resolve) => {
          resolveResponse = resolve
        })
      })
      const source = createDefiLlamaSpotSource({
        getCurrent: getCurrentMock as unknown as DefiLlamaClient['getCurrent']
      })
      const first = new AbortController()
      const second = new AbortController()
      const firstResult = source.getSpotPrice(1, WETH, first.signal)
      const secondResult = source.getSpotPrice(1, OTHER, second.signal)

      await vi.advanceTimersByTimeAsync(5)
      expect(getCurrentMock).toHaveBeenCalledTimes(1)
      first.abort(new Error('first caller stopped waiting'))
      resolveResponse({
        coins: {
          [`ethereum:${OTHER}`]: { price: 1, timestamp: NOW }
        }
      })

      await expect(firstResult).rejects.toThrow('first caller stopped waiting')
      await expect(secondResult).resolves.toMatchObject({ price: 1 })
      expect(getCurrentMock.mock.calls[0][1]).toMatchObject({ aborted: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not call the provider when every queued waiter cancels', async () => {
    vi.useFakeTimers()
    try {
      const getCurrent = vi.fn(async () => ({ coins: {} }))
      const source = createDefiLlamaSpotSource({ getCurrent })
      const controller = new AbortController()
      const result = source.getSpotPrice(1, WETH, controller.signal)
      controller.abort(new Error('caller stopped waiting'))

      await expect(result).rejects.toThrow('caller stopped waiting')
      await vi.advanceTimersByTimeAsync(5)
      expect(getCurrent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps provider concurrency bounded across overlapping arrival waves', async () => {
    vi.useFakeTimers()
    try {
      type CurrentResponse = Awaited<ReturnType<DefiLlamaClient['getCurrent']>>
      let active = 0
      let maximumActive = 0
      const calls: string[][] = []
      const resolvers: Array<(response: CurrentResponse) => void> = []
      const getCurrentMock = vi.fn((keys: string[]) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        calls.push(keys)
        return new Promise<CurrentResponse>((resolve) => {
          resolvers.push((response) => {
            active -= 1
            resolve(response)
          })
        })
      })
      const source = createDefiLlamaSpotSource({
        getCurrent: getCurrentMock as unknown as DefiLlamaClient['getCurrent']
      })
      const tokens = Array.from(
        { length: DEFI_LLAMA_SPOT_BATCH * 2 + 1 },
        (_, index) => `0x${String(index + 1).padStart(40, '0')}`
      )
      const requests = tokens.map((token) => source.getSpotPrice(1, token))

      await vi.advanceTimersByTimeAsync(5)
      expect(getCurrentMock).toHaveBeenCalledTimes(2)

      const extra = source.getSpotPrice(1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      await vi.advanceTimersByTimeAsync(0)
      expect(getCurrentMock).toHaveBeenCalledTimes(2)

      const responseFor = (keys: string[]): CurrentResponse => ({
        coins: Object.fromEntries(keys.map((key) => [key, { price: 1, timestamp: NOW }]))
      })
      const settle = async (index: number) => {
        resolvers[index](responseFor(calls[index]))
        await vi.advanceTimersByTimeAsync(0)
      }

      await settle(0)
      expect(getCurrentMock).toHaveBeenCalledTimes(3)
      await settle(1)
      await settle(2)
      expect(getCurrentMock).toHaveBeenCalledTimes(4)
      await settle(3)

      await expect(Promise.all([...requests, extra])).resolves.toHaveLength(tokens.length + 1)
      expect(maximumActive).toBeLessThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares the full Retry-After cooldown between default source instances', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(
          Response.json({
            coins: {
              [`ethereum:${OTHER}`]: { price: 1, timestamp: NOW }
            }
          })
        )

      const first = createDefiLlamaSpotSource().getSpotPrice(1, WETH)
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
      await vi.advanceTimersByTimeAsync(5)
      await firstRejected

      const second = createDefiLlamaSpotSource().getSpotPrice(1, OTHER)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      await expect(second).resolves.toMatchObject({ price: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('fails fast when the shared cooldown exceeds the batch budget', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '600' } }))
      await vi.advanceTimersByTimeAsync(3_000)

      const first = createDefiLlamaSpotSource().getSpotPrice(1, WETH)
      const firstRejected = expect(first).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
      await vi.advanceTimersByTimeAsync(5)
      await firstRejected

      const second = createDefiLlamaSpotSource().getSpotPrice(1, OTHER)
      const secondRejected = expect(second).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      await vi.advanceTimersByTimeAsync(100)
      await secondRejected
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      const stillBlocked = createDefiLlamaSpotSource().getSpotPrice(1, OTHER)
      const stillBlockedRejected = expect(stillBlocked).rejects.toMatchObject({ code: 'UNAVAILABLE' })
      await vi.advanceTimersByTimeAsync(100)
      await stillBlockedRejected
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // The shared gate retains the provider's complete 600-second
      // Retry-After. We have advanced 60 seconds plus the small assertion
      // windows above, so consume the remaining cooldown before retrying.
      await vi.advanceTimersByTimeAsync(539_900)
      fetchMock.mockImplementationOnce(async () =>
        Response.json({
          coins: {
            [`ethereum:${OTHER}`]: { price: 1, timestamp: Math.floor(Date.now() / 1000) }
          }
        })
      )
      const third = createDefiLlamaSpotSource().getSpotPrice(1, OTHER)
      const thirdResolved = expect(third).resolves.toMatchObject({ price: 1 })
      await vi.advanceTimersByTimeAsync(5)
      await thirdResolved
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('does not call DeFiLlama for unsupported chains', async () => {
    const getCurrentMock = vi.fn(async () => ({ coins: {} }))
    const source = createDefiLlamaSpotSource({
      getCurrent: getCurrentMock as unknown as DefiLlamaClient['getCurrent']
    })

    await expect(source.getSpotPrice(4663, WETH)).resolves.toBeNull()
    await expect(source.getSpotPrice(0, WETH)).resolves.toBeNull()
    expect(getCurrentMock).not.toHaveBeenCalled()
  })
})
