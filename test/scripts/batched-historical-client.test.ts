import { describe, expect, it, vi } from 'vitest'
import { BatchedHistoricalClient } from '../../scripts/lib/batched-historical-client'
import type { DefiLlamaBatchResponse } from '../../src/types'

const day = 1704067199
const a = 'ethereum:0x0000000000000000000000000000000000000001'
const b = 'ethereum:0x0000000000000000000000000000000000000002'

describe('offline historical batching', () => {
  it('prefetches different tokens/days together, preserves observations and caches misses', async () => {
    const getBatchHistorical = vi.fn(
      async (): Promise<DefiLlamaBatchResponse> => ({
        coins: {
          [a]: {
            symbol: 'A',
            prices: [
              { timestamp: day + 5, price: 2 },
              { timestamp: day + 86400 - 5, price: 3 }
            ]
          }
        }
      })
    )
    const client = new BatchedHistoricalClient({ getBatchHistorical })
    await client.prefetch([
      { coin: a, timestamp: day },
      { coin: a, timestamp: day + 86400 },
      { coin: b, timestamp: day }
    ])
    expect(getBatchHistorical).toHaveBeenCalledExactlyOnceWith({ [a]: [day, day + 86400], [b]: [day] })
    expect((await client.getHistorical(day, [a])).coins[a]).toMatchObject({ price: 2, timestamp: day + 5 })
    expect((await client.getHistorical(day + 86400, [a])).coins[a].price).toBe(3)
    expect(await client.getHistorical(day, [b])).toEqual({ coins: {} })
    expect(getBatchHistorical).toHaveBeenCalledTimes(1)
  })

  it('coalesces new dependencies and duplicate in-flight lookups', async () => {
    const getBatchHistorical = vi.fn(async () => ({ coins: {} }))
    const client = new BatchedHistoricalClient({ getBatchHistorical })
    await Promise.all([
      client.getHistorical(day, [a]),
      client.getHistorical(day, [a.toUpperCase()]),
      client.getHistorical(day, [b])
    ])
    expect(getBatchHistorical).toHaveBeenCalledExactlyOnceWith({ [a]: [day], [b]: [day] })
    expect(client.stats.uniqueLookups).toBe(2)
  })

  it('isolates a failed batch and preserves its error without retrying each member', async () => {
    const throttle = new Error('429')
    const getBatchHistorical = vi.fn().mockRejectedValueOnce(throttle).mockResolvedValue({ coins: {} })
    const client = new BatchedHistoricalClient({ getBatchHistorical })
    await client.prefetch(Array.from({ length: 21 }, (_, i) => ({ coin: a, timestamp: day + i * 86400 })))
    await expect(client.getHistorical(day, [a])).rejects.toBe(throttle)
    await expect(client.getHistorical(day, [a])).rejects.toBe(throttle)
    expect(await client.getHistorical(day + 20 * 86400, [a])).toEqual({ coins: {} })
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
    const nextRun = new BatchedHistoricalClient({ getBatchHistorical })
    expect(await nextRun.getHistorical(day, [a])).toEqual({ coins: {} })
  })

  it.each([{}, { coins: [] }, { coins: { [a]: { prices: [{ price: 0, timestamp: day }] } } }])(
    'does not turn a malformed response into a confirmed miss: %j',
    async (response) => {
      const client = new BatchedHistoricalClient({
        getBatchHistorical: vi.fn(async () => response as DefiLlamaBatchResponse)
      })
      await expect(client.getHistorical(day, [a])).rejects.toThrow('Malformed DeFiLlama batch')
    }
  )

  it('rejects out-of-window observations and non-EOD input without normalizing dates', async () => {
    const getBatchHistorical = vi.fn(async () => ({
      coins: { [a]: { prices: [{ price: 2, timestamp: day + 21601 }] } }
    }))
    const client = new BatchedHistoricalClient({ getBatchHistorical })
    expect(await client.getHistorical(day, [a])).toEqual({ coins: {} })
    await expect(client.getHistorical(day - 1, [a])).rejects.toThrow('closed UTC EOD')
    expect(getBatchHistorical).toHaveBeenCalledTimes(1)
  })
})
