import { describe, expect, it, vi } from 'vitest'
import { createDefiLlamaHistoricalSource } from '../../src/sources/defillama'
import type { DefiLlamaClient } from '../../src/clients/defillama'
import { ApiError } from '../../src/http/errors'

const ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

function client(response: unknown) {
  return {
    getHistorical: vi.fn(async () => response)
  } as unknown as DefiLlamaClient
}

describe('createDefiLlamaHistoricalSource', () => {
  it('maps a valid historical response', async () => {
    const getHistorical = vi.fn(async () => ({
      coins: {
        [`ethereum:${ADDRESS}`]: {
          price: 27052,
          symbol: 'WBTC',
          timestamp: 1695197412,
          confidence: 0.99
        }
      }
    }))
    const source = createDefiLlamaHistoricalSource({ getHistorical } as unknown as DefiLlamaClient)

    await expect(source.getHistoricalPrice(1, ADDRESS.toUpperCase(), 1695197412)).resolves.toEqual({
      price: 27052,
      timestamp: 1695197412,
      symbol: 'WBTC',
      confidence: 0.99
    })
    expect(getHistorical).toHaveBeenCalledWith(1695197412, [`ethereum:${ADDRESS}`])
  })

  it('returns null when the response has no price', async () => {
    const source = createDefiLlamaHistoricalSource(client({ coins: {} }))

    await expect(source.getHistoricalPrice(1, ADDRESS, 100)).resolves.toBeNull()
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('returns null for an invalid price (%s)', async (price) => {
    const source = createDefiLlamaHistoricalSource(
      client({
        coins: {
          [`ethereum:${ADDRESS}`]: { price, timestamp: 100 }
        }
      })
    )

    await expect(source.getHistoricalPrice(1, ADDRESS, 100)).resolves.toBeNull()
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0])(
    'returns null for an invalid timestamp (%s)',
    async (timestamp) => {
      const source = createDefiLlamaHistoricalSource(
        client({
          coins: {
            [`ethereum:${ADDRESS}`]: { price: 27052, timestamp }
          }
        })
      )

      await expect(source.getHistoricalPrice(1, ADDRESS, 100)).resolves.toBeNull()
    }
  )

  it('surfaces a transient client failure as a non-NOT_FOUND error', async () => {
    const source = createDefiLlamaHistoricalSource({
      getHistorical: vi.fn(async () => {
        throw new ApiError('INTERNAL_ERROR', 'DefiLlama request failed with status 503')
      })
    } as unknown as DefiLlamaClient)

    await expect(source.getHistoricalPrice(1, ADDRESS, 100)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR'
    })
  })

  it('supports known chain ids and rejects unsupported boundaries', () => {
    const source = createDefiLlamaHistoricalSource(client({ coins: {} }))

    expect(source.supports(1)).toBe(true)
    expect(source.supports(80094)).toBe(true)
    expect(source.supports(0)).toBe(false)
    expect(source.supports(80095)).toBe(false)
  })
})
