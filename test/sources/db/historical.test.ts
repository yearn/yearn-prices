import type { Pool } from '@neondatabase/serverless'
import { describe, expect, it, vi } from 'vitest'
import { createDbHistoricalSource } from '../../../src/sources/db/historical'

const ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const TIMESTAMP = 1_695_254_399

function pool(rows: unknown[]): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool
}

describe('createDbHistoricalSource', () => {
  it('surfaces a query failure as retryable instead of an absent price', async () => {
    const failing = {
      query: vi.fn(async () => {
        throw new Error('connection terminated unexpectedly')
      })
    } as unknown as Pool
    const source = createDbHistoricalSource(failing)

    await expect(source.getHistoricalPrice(1, ADDRESS, TIMESTAMP)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'UNAVAILABLE'
    })
  })

  it('returns a stored price with its original source', async () => {
    const source = createDbHistoricalSource(
      pool([
        {
          chain: 'ethereum',
          token: ADDRESS,
          timestamp: new Date(TIMESTAMP * 1000),
          price: '123.45',
          symbol: 'TOKEN',
          confidence: '0.9',
          source: 'curve'
        }
      ])
    )

    await expect(source.getHistoricalPrice(1, ADDRESS, TIMESTAMP)).resolves.toEqual({
      chain: 'ethereum',
      token: ADDRESS,
      timestamp: TIMESTAMP,
      price: 123.45,
      symbol: 'TOKEN',
      confidence: 0.9,
      source: 'curve'
    })
    expect(source.name).toBe('db')
    expect(source.priority).toBeLessThan(10)
  })

  it('returns null on a miss', async () => {
    const source = createDbHistoricalSource(pool([]))

    await expect(source.getHistoricalPrice(1, ADDRESS, TIMESTAMP)).resolves.toBeNull()
  })

  it.each(['0', '-1'])('treats a stored %s price as a miss so the next source is tried', async (price) => {
    const source = createDbHistoricalSource(
      pool([
        {
          chain: 'ethereum',
          token: ADDRESS,
          timestamp: new Date(TIMESTAMP * 1000),
          price,
          symbol: 'TOKEN',
          confidence: null,
          source: 'defillama'
        }
      ])
    )

    await expect(source.getHistoricalPrice(1, ADDRESS, TIMESTAMP)).resolves.toBeNull()
  })
})
