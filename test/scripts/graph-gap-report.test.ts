import { describe, expect, it } from 'vitest'
import { graphGapReport, safePricingFailure } from '../../scripts/lib/graph-gap-report'
import { parseManifest } from '../../src/backfill/manifest'
import type { GraphNode } from '../../src/sources/onchain/graph'

const token = '0x1111111111111111111111111111111111111111'
const childToken = '0x2222222222222222222222222222222222222222'
const timestamp = 1704067199
const manifest = parseManifest(
  JSON.stringify({ version: 1, targets: [{ chainId: 1, token, eodTimestamp: timestamp }] })
)
function node(key = 'root', address = token): GraphNode {
  return {
    key,
    target: { chainId: 1, token: address, timestamp },
    depth: 0,
    parents: [],
    routes: [],
    attempts: [],
    notApplicable: [],
    market: 'missing',
    path: null,
    reason: 'unsupported',
    height: 0
  }
}

describe('shareable graph gap evidence', () => {
  it('reports the actual missing leaf behind a vault or LP', () => {
    const root = node()
    const child = node('child', childToken)
    root.routes = [
      {
        adapter: 'curve-reserve-nav',
        dependencies: [{ key: 'child', label: 'coin', target: child.target }],
        metadata: {}
      }
    ]
    const report = graphGapReport({ roots: ['root'], nodes: [root, child] }, manifest)
    expect(report.targets[0].blockers).toEqual([expect.objectContaining({ token: childToken, reason: 'unsupported' })])
    expect(report.summary).toEqual({ targets: 1, candidates: 0, unresolved: 1, rejected: 0 })
  })

  it('keeps failed reads retryable and excludes private provider text', () => {
    const root = node()
    root.market = 'error'
    root.attempts = [
      {
        adapter: 'market-price',
        reason: 'retryable',
        error: 'RPC https://private.example/SECRET_TOKEN payload password=SECRET_PASSWORD'
      }
    ]
    const report = graphGapReport({ roots: ['root'], nodes: [root] }, manifest)
    expect(report.targets[0].blockers[0].reason).toBe('retryable')
    expect(JSON.stringify(report)).not.toContain('SECRET')
    expect(JSON.stringify(report)).not.toContain('private.example')
  })

  it('allows only tightly constrained pricing messages', () => {
    expect(safePricingFailure('InvalidPricingError: Curve coin 1 balance 123 exceeds pool holdings 0')).toBe(
      'Curve coin 1 balance 123 exceeds pool holdings 0'
    )
    expect(
      safePricingFailure('InvalidPricingError: Curve coin 1 balance 123 exceeds pool holdings 0 https://secret')
    ).toBeNull()
    expect(safePricingFailure('Error: provider password=secret')).toBeNull()
  })

  it('rejects missing roots, reordered identities and stale candidate evidence', () => {
    expect(() => graphGapReport({ roots: [], nodes: [] }, manifest)).toThrow('count mismatch')
    expect(() => graphGapReport({ roots: ['root'], nodes: [node('root', childToken)] }, manifest)).toThrow(
      'identity mismatch'
    )
    const root = node()
    root.market = 'price'
    root.path = {
      chainId: 1,
      token,
      requestedTimestamp: timestamp,
      observedTimestamp: timestamp - 30_000,
      priceUsd: 1,
      source: 'defillama',
      adapter: 'defillama',
      symbol: null,
      confidence: null,
      inputs: [],
      metadata: {},
      blockNumber: null
    }
    expect(graphGapReport({ roots: ['root'], nodes: [root] }, manifest).targets[0].status).toBe('invalid-candidate')
    root.path.observedTimestamp = timestamp
    expect(graphGapReport({ roots: ['root'], nodes: [root] }, manifest).targets[0].status).toBe('validated-candidate')
  })
})
