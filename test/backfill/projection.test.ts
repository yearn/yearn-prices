import { expect, it } from 'vitest'
import { reconcileTargetOutcomes, remainingGapPositions, remainingPriceProjection } from '../../src/backfill/projection'
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

it('reconciles final outcomes and retains finalization rejections as remaining roots', () => {
  const result = reconcileTargetOutcomes(
    [
      { target: { chainId: 1, token: 'stored', eodTimestamp: 1 }, status: 'skipped_existing' },
      { target: { chainId: 1, token: 'inserted', eodTimestamp: 1 }, status: 'inserted' },
      { target: { chainId: 1, token: 'concurrent', eodTimestamp: 1 }, status: 'skipped_concurrent_existing' },
      { target: { chainId: 1, token: 'rejected', eodTimestamp: 1 }, status: 'rejected_implausible' }
    ],
    4
  )

  expect(result).toMatchObject({
    targetCount: 4,
    alreadyStored: 1,
    insertedOrProjected: 1,
    concurrentExisting: 1,
    remainingOriginalTargets: 1,
    rejectedImplausible: 1
  })
  expect(result.remaining.map((outcome) => outcome.target.token)).toEqual(['rejected'])
})

it('rejects incomplete or duplicate final target outcomes', () => {
  const outcome = { target: { chainId: 1, token: '0xabc', eodTimestamp: 1 }, status: 'rejected_implausible' }
  expect(() => reconcileTargetOutcomes([outcome], 2)).toThrow('do not reconcile')
  expect(() =>
    reconcileTargetOutcomes([outcome, { ...outcome, target: { ...outcome.target, token: '0xAbC' } }], 2)
  ).toThrow('Duplicate final target outcome')
})
