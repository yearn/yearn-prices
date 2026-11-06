import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../src/http/errors'
import { resolveCurrentFallback } from '../../../src/sources/onchain/current-fallback'
import type { Env } from '../../../src/types'

const mocks = vi.hoisted(() => ({
  chainlink: vi.fn(),
  defiLlama: vi.fn(),
  enso: vi.fn(),
  derived: vi.fn()
}))

vi.mock('../../../src/sources/chainlink', () => ({
  createChainlinkHistoricalSource: vi.fn(() => ({
    supports: () => true,
    getHistoricalPrice: mocks.chainlink
  }))
}))

vi.mock('../../../src/sources/defillama', () => ({
  createDefiLlamaSpotSource: vi.fn(() => ({
    supports: () => true,
    getSpotPrice: mocks.defiLlama
  }))
}))

vi.mock('../../../src/sources/enso', () => ({
  createEnsoSpotSource: vi.fn(() => ({
    supports: () => true,
    getSpotPrice: mocks.enso
  }))
}))

vi.mock('../../../src/sources/onchain/source', () => ({
  createOnchainSpotSource: vi.fn(() => ({
    supports: () => true,
    getSpotPrice: mocks.derived
  }))
}))

const TOKEN_A = '0x0000000000000000000000000000000000000001'
const TOKEN_B = '0x0000000000000000000000000000000000000002'
const TOKEN_C = '0x0000000000000000000000000000000000000003'
const ENV = { ENSO_API_KEY: 'test-key' } as unknown as Env

function target(token: string) {
  return { chainId: 1, chain: 'ethereum', token }
}

function quote(price: number) {
  return { price, timestamp: 1_700_000_000, symbol: 'TEST', confidence: 0.9 }
}

describe('resolveCurrentFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses Chainlink, then derived, then Enso while preserving source provenance', async () => {
    mocks.chainlink.mockImplementation(async (_chainId: number, token: string) => {
      if (token === TOKEN_A) return quote(1)
      return null
    })
    mocks.derived.mockImplementation(async (_chainId: number, token: string) => {
      if (token === TOKEN_B) return quote(2)
      return null
    })
    mocks.enso.mockImplementation(async (_chainId: number, token: string) => {
      if (token === TOKEN_C) return quote(3)
      return null
    })

    const result = await resolveCurrentFallback(ENV, [target(TOKEN_A), target(TOKEN_B), target(TOKEN_C)], new Map())

    expect(result.failed).toBe(false)
    expect(result.prices).toEqual(
      new Map([
        [
          'ethereum:' + TOKEN_A,
          { ...quote(1), source: 'chainlink', observationEndpoint: 'onchain.chainlink.latestRoundData' }
        ],
        ['ethereum:' + TOKEN_B, { ...quote(2), source: 'derived', observationEndpoint: 'onchain.derived' }],
        ['ethereum:' + TOKEN_C, { ...quote(3), source: 'enso', observationEndpoint: 'enso.current' }]
      ])
    )
    expect(mocks.chainlink).toHaveBeenCalledTimes(3)
    expect(mocks.derived).toHaveBeenCalledTimes(2)
    expect(mocks.enso).toHaveBeenCalledTimes(1)
  })

  it('treats NOT_FOUND as a miss but reports other provider failures', async () => {
    mocks.chainlink.mockRejectedValue(new ApiError('NOT_FOUND', 'no feed'))
    mocks.derived.mockResolvedValue(null)
    mocks.enso.mockResolvedValue(quote(4))

    const result = await resolveCurrentFallback(ENV, [target(TOKEN_A)], new Map())

    expect(result.failed).toBe(false)
    expect(result.prices.get('ethereum:' + TOKEN_A)).toMatchObject({ source: 'enso', price: 4 })

    mocks.chainlink.mockRejectedValue(new ApiError('UNAVAILABLE', 'rpc down'))
    mocks.enso.mockResolvedValue(null)
    const failed = await resolveCurrentFallback(ENV, [target(TOKEN_A)], new Map())

    expect(failed.failed).toBe(true)
    expect(failed.prices).toEqual(new Map())
  })

  it('stops starting fallback sources after the caller aborts the shared deadline', async () => {
    const controller = new AbortController()
    mocks.chainlink.mockImplementation(() => new Promise(() => {}))

    const pending = resolveCurrentFallback(ENV, [target(TOKEN_A)], new Map(), controller.signal)
    controller.abort()
    const result = await pending

    expect(result.failed).toBe(true)
    expect(result.prices).toEqual(new Map())
    expect(mocks.chainlink).toHaveBeenCalledOnce()
    expect(mocks.derived).not.toHaveBeenCalled()
    expect(mocks.enso).not.toHaveBeenCalled()
  })

  it('uses one internal deadline for all targets and preserves completed siblings', async () => {
    vi.useFakeTimers()
    let deadlineSignal: AbortSignal | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), delay)
      deadlineSignal = controller.signal
      return controller.signal
    })

    let derivedSignal: AbortSignal | undefined
    mocks.chainlink.mockImplementation(async (_chainId: number, token: string) => {
      if (token === TOKEN_A) return quote(5)
      return new Promise((resolve) => setTimeout(() => resolve(null), 1_000))
    })
    mocks.derived.mockImplementation((_chainId: number, token: string, signal: AbortSignal) => {
      if (token !== TOKEN_B) return null
      derivedSignal = signal
      return new Promise(() => {})
    })
    mocks.enso.mockResolvedValue(quote(9))

    let settled = false
    const pending = resolveCurrentFallback(ENV, [target(TOKEN_A), target(TOKEN_B)], new Map()).then((result) => {
      settled = true
      return result
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.derived).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.derived).toHaveBeenCalledOnce()
    expect(derivedSignal).toBe(deadlineSignal)

    await vi.advanceTimersByTimeAsync(1_499)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    expect(settled).toBe(true)
    expect(deadlineSignal?.aborted).toBe(true)
    expect(result.failed).toBe(true)
    expect(result.prices.get('ethereum:' + TOKEN_A)).toMatchObject({ source: 'chainlink', price: 5 })
    expect(result.prices.has('ethereum:' + TOKEN_B)).toBe(false)
    expect(mocks.enso).not.toHaveBeenCalled()
    expect(AbortSignal.timeout).toHaveBeenCalledOnce()
  })
})
