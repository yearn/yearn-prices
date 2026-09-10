import { expect, it } from 'vitest'
import { remainingGapPositions, remainingPriceProjection } from '../../src/backfill/projection'
import type { GraphNode } from '../../src/sources/onchain/graph'

function node(key: string, dependencies: string[] = [], priced = false): GraphNode {
  return {
    key,
    target: { chainId: 1, token: key, timestamp: 100 },
    path: priced ? {} : null,
    reason: priced ? null : 'unsupported',
    routes: dependencies.length
      ? [
          {
            dependencies: dependencies.map((key) => ({
              key,
              target: { chainId: 1, token: key, timestamp: 100 }
            }))
          }
        ]
      : []
  } as GraphNode
}
it('shows shared underlying blockers instead of dependent pools', () => {
  const result = remainingPriceProjection(
    [node('pool1', ['child']), node('pool2', ['child']), node('child')],
    ['pool1', 'pool2']
  )
  expect(result.assets.map((a) => a.token)).toEqual(['child'])
  expect(result.assets[0].dates).toHaveLength(1)
  expect(result.assets[0].affectedRootCount).toBe(2)
  expect(result.dependencyOnlyAssetCount).toBe(2)
})
it('omits failures from resolved roots and unused graph branches', () => {
  const result = remainingPriceProjection(
    [node('resolved', ['unused'], true), node('unused'), node('remaining')],
    ['remaining']
  )
  expect(result.assets.map((a) => a.token)).toEqual(['remaining'])
})
it('keeps a rejected candidate unresolved instead of treating it as a completed write', () => {
  expect(remainingPriceProjection([node('rejected', [], true)], ['rejected']).assets[0].token).toBe('rejected')
})
it('refuses incomplete projection evidence', () => {
  expect(() => remainingPriceProjection([], ['absent'])).toThrow('Missing historical')
})

it('classifies remaining gaps without marking any now-covered', () => {
  expect(remainingGapPositions([5, 1, 3, 2, 4, 3], 2, 4)).toEqual({
    before: [1],
    interior: [2, 3, 4],
    after: [5]
  })
})
it('keeps unknown history separate from positional gaps', () => {
  expect(remainingGapPositions([1, 3], null, null)).toEqual({ 'no-known-history': [1, 3] })
})
