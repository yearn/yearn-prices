import { describe, expect, it, vi } from 'vitest'
import { BatchedHistoricalClient } from '../../scripts/lib/batched-historical-client'
import { prefetchHistoricalFrontiers } from '../../scripts/lib/historical-frontiers'
import { RecursivePriceEngine } from '../../src/sources/onchain/engine'
import type {
  MarketPriceResolver,
  RecursivePriceAdapter,
  RecursivePriceTarget
} from '../../src/sources/onchain/types'

const day = 1704067199
const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const coin = (n: number) => `ethereum:${token(n)}`
const target = (n: number): RecursivePriceTarget => ({ chainId: 1, token: token(n), timestamp: day })

describe('historical dependency frontiers', () => {
  it('batches shared nested children across roots and resolves newly revealed siblings in later rounds', async () => {
    const getBatchHistorical = vi.fn(async (payload: Record<string, number[]>) => ({
      coins: Object.fromEntries(
        Object.keys(payload)
          .filter((key) => [coin(4), coin(5)].includes(key))
          .map((key) => [
            key,
            {
              prices: [{ timestamp: day, price: key === coin(4) ? 2 : 3 }]
            }
          ])
      )
    }))
    const provider = new BatchedHistoricalClient({ getBatchHistorical })
    const market: MarketPriceResolver = async (t) => {
      const quote = (await provider.getHistorical(t.timestamp!, [`ethereum:${t.token}`])).coins[
        `ethereum:${t.token}`
      ]
      return quote
        ? {
            chainId: 1,
            token: t.token,
            requestedTimestamp: day,
            observedTimestamp: quote.timestamp,
            priceUsd: quote.price,
            symbol: null,
            confidence: null,
            source: 'defillama',
            adapter: 'defillama',
            inputs: [],
            metadata: {}
          }
        : null
    }
    const adapter: RecursivePriceAdapter = {
      name: 'fixture-wrapper',
      async resolve(t, ctx) {
        if ([token(1), token(2)].includes(t.token)) {
          const first = await ctx.require(target(3), 'shared wrapper')
          // This sibling is only discoverable after the first child resolves.
          const second = await ctx.require(target(5), 'sibling')
          return {
            priceUsd: first.priceUsd + second.priceUsd,
            inputs: [{ path: first }, { path: second }],
            metadata: {}
          }
        }
        if (t.token === token(3)) {
          const leaf = await ctx.require(target(4), 'nested leaf')
          return { priceUsd: leaf.priceUsd, inputs: [{ path: leaf }], metadata: {} }
        }
        return null
      }
    }
    const resolve = (t: RecursivePriceTarget) => new RecursivePriceEngine(market, [adapter]).resolve(t)
    const roots = [target(1), target(2)]
    await provider.prefetch(roots.map((t) => ({ coin: `ethereum:${t.token}`, timestamp: day })))
    const summary = await prefetchHistoricalFrontiers({
      provider,
      roots,
      concurrency: 1,
      maxRounds: 8,
      probe: resolve
    })
    expect(summary).toEqual({ rounds: 3, discovered: 3, converged: true })
    expect(getBatchHistorical.mock.calls.map(([payload]) => payload)).toEqual([
      { [coin(1)]: [day], [coin(2)]: [day] },
      { [coin(3)]: [day], [coin(4)]: [day] },
      { [coin(5)]: [day] }
    ])
    for (const root of roots) expect((await resolve(root)).path?.priceUsd).toBe(5)
    expect(getBatchHistorical).toHaveBeenCalledTimes(3)
  })

  it('does not cache provisional misses and restores normal fetching after a failed probe', async () => {
    const getBatchHistorical = vi.fn(async () => ({ coins: {} }))
    const provider = new BatchedHistoricalClient({ getBatchHistorical })
    await expect(
      provider.discover(async () => {
        await provider.getHistorical(day, [coin(1)])
        throw new Error('probe interrupted')
      })
    ).rejects.toThrow('probe interrupted')
    expect(getBatchHistorical).not.toHaveBeenCalled()
    await provider.getHistorical(day, [coin(1)])
    expect(getBatchHistorical).toHaveBeenCalledTimes(1)
  })

  it('retains failed batches as retryable through discovery without refetching them', async () => {
    const getBatchHistorical = vi.fn(async () => {
      throw new Error('429')
    })
    const provider = new BatchedHistoricalClient({ getBatchHistorical })
    await provider.prefetch([{ coin: coin(1), timestamp: day }])
    await provider.discover(async () => {
      await expect(provider.getHistorical(day, [coin(1)])).rejects.toThrow('429')
    })
    expect(getBatchHistorical).toHaveBeenCalledTimes(1)
  })

  it('bounds discovery and leaves unseen targets available to final dynamic batching', async () => {
    const getBatchHistorical = vi.fn(async () => ({ coins: {} }))
    const provider = new BatchedHistoricalClient({ getBatchHistorical })
    const summary = await prefetchHistoricalFrontiers({
      provider,
      roots: [1],
      concurrency: 1,
      maxRounds: 1,
      probe: async () => provider.getHistorical(day, [coin(1)])
    })
    expect(summary).toEqual({ rounds: 1, discovered: 1, converged: false })
    await provider.getHistorical(day, [coin(2)])
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
  })
})
