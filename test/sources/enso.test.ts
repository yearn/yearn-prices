import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnsoSpotSource } from '../../src/sources/enso'
import { toUnixSeconds } from '../../src/utils'

const ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

function response(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    decimals: 8,
    price: 27052,
    address: ADDRESS,
    chainId: 1,
    symbol: 'WBTC',
    timestamp: 1695197412,
    confidence: 0.99,
    ...overrides
  }
}

describe('createEnsoSpotSource', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('maps a valid Enso response to a spot price', async () => {
    fetchMock.mockResolvedValue(response(200, body()))
    const source = createEnsoSpotSource('enso-key')

    await expect(source.getSpotPrice(1, ADDRESS.toUpperCase())).resolves.toEqual({
      price: 27052,
      timestamp: 1695197412,
      symbol: 'WBTC',
      confidence: 0.99
    })
  })

  it('converts millisecond timestamps to unix seconds', async () => {
    const timestamp = 1781549905855
    fetchMock.mockResolvedValue(response(200, body({ timestamp })))

    const price = await createEnsoSpotSource('enso-key').getSpotPrice(1, ADDRESS)

    expect(price?.timestamp).toBe(toUnixSeconds(timestamp))
  })

  it('uses the current time when Enso omits a valid timestamp', async () => {
    fetchMock.mockResolvedValue(response(200, body({ timestamp: 0 })))
    const before = Math.floor(Date.now() / 1000)

    const price = await createEnsoSpotSource('enso-key').getSpotPrice(1, ADDRESS)

    const after = Math.floor(Date.now() / 1000)
    expect(price?.timestamp).toBeGreaterThanOrEqual(before)
    expect(price?.timestamp).toBeLessThanOrEqual(after + 1)
  })

  it('throws NOT_FOUND for an invalid price', async () => {
    fetchMock.mockResolvedValue(response(200, body({ price: 0 })))

    await expect(createEnsoSpotSource('enso-key').getSpotPrice(1, ADDRESS)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('surfaces a transient upstream failure as a non-NOT_FOUND error', async () => {
    fetchMock.mockResolvedValue(response(503))
    vi.useFakeTimers()

    const assertion = expect(createEnsoSpotSource('enso-key').getSpotPrice(1, ADDRESS)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    })
    await vi.runAllTimersAsync()
    await assertion

    vi.useRealTimers()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('supports known chain ids and rejects unsupported boundaries', () => {
    const source = createEnsoSpotSource('enso-key')

    expect(source.supports(1)).toBe(true)
    expect(source.supports(80094)).toBe(true)
    expect(source.supports(0)).toBe(false)
    expect(source.supports(80095)).toBe(false)
  })
})
