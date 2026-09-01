import { describe, expect, it, vi } from 'vitest'
import type { DefiLlamaClient } from '../../../src/clients/defillama'
import { ApiError } from '../../../src/http/errors'
import { createDefiLlamaHistoricalSource } from '../../../src/sources/defillama/historical'

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

  it('resolves multiple targets through the provider batch endpoint', async () => {
    const secondAddress = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const timestamp = 1695254399
    const getBatchHistorical = vi.fn(async () => ({
      coins: {
        [`ethereum:${ADDRESS}`]: {
          symbol: 'WETH',
          prices: [{ price: 1800, timestamp, confidence: 0.99 }]
        },
        [`ethereum:${secondAddress}`]: {
          symbol: 'USDC',
          prices: [{ price: 1, timestamp, confidence: 0.98 }]
        }
      }
    }))
    const source = createDefiLlamaHistoricalSource({ getBatchHistorical } as unknown as DefiLlamaClient)
    const targets = [
      { chainId: 1, token: ADDRESS, timestamp },
      { chainId: 1, token: secondAddress, timestamp }
    ]

    await expect(source.getBatchHistoricalPrices(targets)).resolves.toEqual([
      {
        target: targets[0],
        price: { price: 1800, timestamp, symbol: 'WETH', confidence: 0.99 }
      },
      {
        target: targets[1],
        price: { price: 1, timestamp, symbol: 'USDC', confidence: 0.98 }
      }
    ])
    expect(getBatchHistorical).toHaveBeenCalledTimes(1)
    expect(getBatchHistorical).toHaveBeenCalledWith({
      [`ethereum:${ADDRESS}`]: [timestamp],
      [`ethereum:${secondAddress}`]: [timestamp]
    })
  })

  it('keeps requesting later payload groups after one group fails', async () => {
    const timestamp = 1695254399
    const tokens = Array.from({ length: 6 }, (_, index) => `0x${String(index + 1).repeat(40)}`)
    const getBatchHistorical = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('INTERNAL_ERROR', 'rate limited'))
      .mockResolvedValueOnce({
        coins: {
          [`ethereum:${tokens[5]}`]: { symbol: 'LAST', prices: [{ price: 7, timestamp, confidence: 0.9 }] }
        }
      })
    const source = createDefiLlamaHistoricalSource({ getBatchHistorical } as unknown as DefiLlamaClient)
    const targets = tokens.map((token) => ({ chainId: 1, token, timestamp }))

    await expect(source.getBatchHistoricalPrices(targets)).resolves.toEqual([
      { target: targets[5], price: { price: 7, timestamp, symbol: 'LAST', confidence: 0.9 } }
    ])
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
  })

  it('rethrows when every payload group fails', async () => {
    const getBatchHistorical = vi.fn().mockRejectedValue(new ApiError('INTERNAL_ERROR', 'rate limited'))
    const source = createDefiLlamaHistoricalSource({ getBatchHistorical } as unknown as DefiLlamaClient)

    await expect(
      source.getBatchHistoricalPrices([{ chainId: 1, token: ADDRESS, timestamp: 1695254399 }])
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
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
