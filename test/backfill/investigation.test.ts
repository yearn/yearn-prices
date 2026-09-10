import { expect, it } from 'vitest'
import type { GraphNode } from '../../src/sources/onchain/graph'
import { dependencyBlockers, needsOwnPricing } from '../../src/backfill/investigation'
function fixture() {
  const child = { key: 'child', path: null, reason: 'unsupported' } as GraphNode
  const root = {
    path: null,
    reason: 'unsupported',
    routes: [{ dependencies: [{ key: 'child', target: { chainId: 1, token: '0xABC', timestamp: 100 } }] }]
  } as GraphNode
  return { root, child, nodes: new Map([['child', child]]) }
}
it('identifies a discovered route blocked only by constituent prices', () => {
  const { root, nodes } = fixture()
  expect(dependencyBlockers(root, nodes)).toEqual([{ chainId: 1, token: '0xabc', timestamp: 100 }])
})
it.each(['retryable', 'invalid', 'cycle', 'budget', 'max-depth'])(
  'retains %s failures for investigation',
  (reason) => {
    const { root, nodes } = fixture()
    root.reason = reason as GraphNode['reason']
    expect(dependencyBlockers(root, nodes)).toBeNull()
  }
)
it('retains absent routes and discovery cutoffs', () => {
  const { root, nodes } = fixture()
  root.routes[0].dependencies[0].cutoff = 'budget'
  expect(dependencyBlockers(root, nodes)).toBeNull()
  root.routes = []
  expect(dependencyBlockers(root, nodes)).toBeNull()
})
it('filters dates individually while retaining legacy unclassified observations', () => {
  expect(needsOwnPricing({ status: 'unresolved', pricingNeed: 'dependency' })).toBe(false)
  expect(needsOwnPricing({ status: 'unresolved', pricingNeed: 'direct' })).toBe(true)
  expect(needsOwnPricing({ status: 'unresolved' })).toBe(true)
  expect(needsOwnPricing({ status: 'candidate' })).toBe(false)
})
