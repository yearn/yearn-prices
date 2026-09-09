import { describe, expect, it, vi } from 'vitest'
import { graphKey, resolveHistoricalGraph } from '../../../src/sources/onchain/graph'
import { plannedAdapter } from '../../../src/sources/onchain/plan'
import { ApiError } from '../../../src/http/errors'
import type { RecursivePriceTarget, ResolvedPricePath } from '../../../src/sources/onchain/types'
const t = (n: number, block = 10): RecursivePriceTarget => ({
  chainId: 1,
  token: `0x${n.toString(16).padStart(40, '0')}`,
  timestamp: 1704067199,
  blockNumber: block
})
const price = (target: RecursivePriceTarget, priceUsd = 2): ResolvedPricePath => ({
  ...target,
  requestedTimestamp: target.timestamp,
  observedTimestamp: target.timestamp!,
  priceUsd,
  source: 'defillama',
  adapter: 'defillama',
  inputs: [],
  symbol: null,
  confidence: null,
  metadata: {}
})
const id = (target: RecursivePriceTarget) => parseInt(target.token, 16)
function fixture(edges: Record<number, number[]>) {
  const discover = vi.fn(async (target: RecursivePriceTarget) => {
    const children = edges[id(target)]
    return children
      ? {
          dependencies: children.map((n) => ({ target: t(n, target.blockNumber!), label: 'fixture child' })),
          metadata: { snapshot: target.blockNumber },
          evaluate: (inputs: ResolvedPricePath[]) => ({
            priceUsd: inputs.reduce((n, path) => n + path.priceUsd, 0),
            inputs: inputs.map((path) => ({ path })),
            metadata: {}
          })
        }
      : null
  })
  return { discover, adapter: plannedAdapter('fixture', discover) }
}

describe('historical price graph', () => {
  it('discovers every sibling despite a missing leaf and shares nested state across roots', async () => {
    const { adapter, discover } = fixture({ 1: [3, 4], 2: [3], 3: [5] })
    const frontiers: number[][] = []
    const result = await resolveHistoricalGraph({
      roots: [t(1), t(2)],
      market: async (target) => (id(target) === 5 ? price(target) : null),
      prefetch: async (targets) => {
        frontiers.push(targets.map(id))
      },
      adapters: () => [adapter]
    })
    expect(frontiers).toEqual([[1, 2], [3, 4], [5]])
    expect(discover.mock.calls.filter(([target]) => id(target) === 3)).toHaveLength(1)
    expect(result.nodes.find((n) => id(n.target) === 1)?.routes[0].dependencies).toHaveLength(2)
    expect(result.nodes.find((n) => id(n.target) === 1)?.path).toBeNull()
    expect(result.nodes.find((n) => id(n.target) === 2)?.path?.priceUsd).toBe(2)
    expect(result.nodes.find((n) => id(n.target) === 3)?.parents).toHaveLength(2)
  })
  it('keeps block contexts separate', async () => {
    const { adapter, discover } = fixture({ 1: [2] })
    const result = await resolveHistoricalGraph({
      roots: [t(1, 10), t(1, 20)],
      market: async (target) => (id(target) === 2 ? price(target, target.blockNumber!) : null),
      prefetch: async () => {},
      adapters: () => [adapter]
    })
    expect(result.nodes).toHaveLength(4)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(result.nodes.slice(0, 2).map((n) => n.path?.priceUsd)).toEqual([10, 20])
  })
  it('reports cycles and budget/depth cutoffs without making them terminal misses', async () => {
    const { adapter } = fixture({ 1: [2], 2: [1] })
    const run = (extra = {}) =>
      resolveHistoricalGraph({
        roots: [t(1)],
        market: async () => null,
        prefetch: async () => {},
        adapters: () => [adapter],
        ...extra
      })
    expect((await run()).nodes[0].reason).toBe('cycle')
    expect((await run({ maxNodes: 1 })).nodes[0].reason).toBe('budget')
    expect((await run({ maxDepth: 1 })).nodes[0].reason).toBe('max-depth')
  })
  it('propagates failed acquisition separately from confirmed absent observations', async () => {
    const { adapter } = fixture({ 1: [2, 3] })
    const result = await resolveHistoricalGraph({
      roots: [t(1)],
      market: async (target) => {
        if (id(target) === 2) throw new ApiError('UNAVAILABLE', '429')
        return null
      },
      prefetch: async () => {},
      adapters: () => [adapter]
    })
    expect(result.nodes.find((n) => id(n.target) === 2)?.market).toBe('error')
    expect(result.nodes.find((n) => id(n.target) === 3)?.market).toBe('missing')
    expect(result.nodes[0].reason).toBe('retryable')
  })
  it('prefers the earlier adapter when its deeper inputs become available', async () => {
    const high = fixture({ 1: [2], 2: [3] }).adapter
    const low = plannedAdapter('fallback', async (target) =>
      id(target) === 1
        ? { dependencies: [], metadata: {}, evaluate: () => ({ priceUsd: 99, inputs: [], metadata: {} }) }
        : null
    )
    const result = await resolveHistoricalGraph({
      roots: [t(1)],
      market: async (target) => (id(target) === 3 ? price(target, 7) : null),
      prefetch: async () => {},
      adapters: () => [high, low]
    })
    expect(result.nodes[0].path?.priceUsd).toBe(7)
    expect(result.nodes[0].path?.adapter).toBe('fixture')
  })
  it('can resolve a cycle through an independent alternative without circular price evidence', async () => {
    const cyclic = fixture({ 1: [2], 2: [1] }).adapter
    const fallback = plannedAdapter('anchor', async (target) =>
      id(target) === 2
        ? { dependencies: [], metadata: {}, evaluate: () => ({ priceUsd: 3, inputs: [], metadata: {} }) }
        : null
    )
    const result = await resolveHistoricalGraph({
      roots: [t(1)],
      market: async () => null,
      prefetch: async () => {},
      adapters: () => [cyclic, fallback]
    })
    expect(result.nodes.find((n) => n.key === graphKey(t(1)))?.path?.priceUsd).toBe(3)
    expect(result.nodes.find((n) => n.key === graphKey(t(2)))?.path?.adapter).toBe('anchor')
  })
})
