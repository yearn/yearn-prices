import { describe, expect, it } from 'vitest'
import { validateGraphResolution } from '../../src/backfill/graph-validation'
import { parseManifest } from '../../src/backfill/manifest'
import { REJECTED_OBSERVATIONS } from '../../src/prices/rejections'
import type { GraphNode } from '../../src/sources/onchain/graph'

const timestamp = 1704067199
const token = '0x1111111111111111111111111111111111111111'
const childToken = '0x2222222222222222222222222222222222222222'
const missingToken = '0x3333333333333333333333333333333333333333'
const target = parseManifest(JSON.stringify({ version: 1, targets: [{ chainId: 1, token, eodTimestamp: timestamp }] }))
  .targets[0]
function fixture() {
  const child = {
    key: 'child',
    target: { chainId: 1, token: childToken, timestamp, blockNumber: 100 },
    market: 'price',
    routes: [],
    path: {
      chainId: 1,
      token: childToken,
      requestedTimestamp: timestamp,
      observedTimestamp: timestamp,
      priceUsd: 1,
      source: 'defillama',
      adapter: 'defillama',
      inputs: [],
      metadata: {},
      blockNumber: null
    }
  } as unknown as GraphNode
  const root = {
    key: 'root',
    target: { chainId: 1, token, timestamp },
    market: 'missing',
    routes: [{ adapter: 'curve-reserve-nav', dependencies: [{ key: 'child' }] }],
    path: {
      ...child.path,
      token,
      source: 'derived',
      adapter: 'curve-reserve-nav',
      blockNumber: 100,
      inputs: [{ ...child.path }],
      metadata: { block: { number: 100, timestamp: timestamp - 5, requestedTimestamp: timestamp } }
    }
  } as unknown as GraphNode
  return {
    root,
    child,
    nodes: new Map([
      ['root', root],
      ['child', child]
    ])
  }
}
describe('graph finalization evidence', () => {
  it('rejects a derived root whose selected child is a quarantined provider quote', () => {
    const { root, child, nodes } = fixture()
    const rejected = REJECTED_OBSERVATIONS[0]
    for (const node of [root, child]) {
      node.target.timestamp = rejected.timestamp
      node.path!.requestedTimestamp = rejected.timestamp
      node.path!.observedTimestamp = rejected.timestamp
    }
    child.target.token = rejected.token
    child.path!.token = rejected.token
    child.path!.priceUsd = 72_061_183.43742615
    root.path!.inputs[0] = { ...child.path! }
    root.path!.metadata.block = {
      number: 100,
      timestamp: rejected.timestamp - 5,
      requestedTimestamp: rejected.timestamp
    }
    expect(() => validateGraphResolution(root, { ...target, eodTimestamp: rejected.timestamp }, nodes)).toThrow(
      'quarantined provider observation'
    )
  })
  it.each([-21600, 21600])('accepts the 6-hour boundary %s', (offset) => {
    const { root, child, nodes } = fixture()
    child.path!.observedTimestamp += offset
    root.path!.inputs[0].observedTimestamp += offset
    expect(validateGraphResolution(root, target, nodes).price).toBe(1)
  })
  it('rejects a late child even when the root timestamp is in range', () => {
    const { root, child, nodes } = fixture()
    child.path!.observedTimestamp += 21601
    root.path!.inputs[0].observedTimestamp += 21601
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('6-hour')
  })
  it('rejects a selected dependency missing from evidence', () => {
    const { root, nodes } = fixture()
    nodes.delete('child')
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('Incomplete')
  })
  it('rejects future block evidence', () => {
    const { root, nodes } = fixture()
    root.path!.metadata.block = { number: 100, timestamp: timestamp + 1, requestedTimestamp: timestamp }
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('block evidence')
  })
  it('accepts a derived route whose missing dependency is a terminal miss', () => {
    const { root, nodes } = fixture()
    root.routes[0].dependencies.push({ key: 'missing' } as never)
    nodes.set('missing', {
      key: 'missing',
      target: { chainId: 1, token: missingToken, timestamp, blockNumber: 100 },
      market: 'missing',
      routes: [],
      attempts: [],
      path: null
    } as unknown as GraphNode)
    expect(validateGraphResolution(root, target, nodes).price).toBe(1)
  })
  it('rejects a derived route whose missing dependency has attempts', () => {
    const { root, nodes } = fixture()
    root.routes[0].dependencies.push({ key: 'missing' } as never)
    nodes.set('missing', {
      key: 'missing',
      target: { chainId: 1, token: missingToken, timestamp, blockNumber: 100 },
      market: 'error',
      routes: [],
      attempts: [{ adapter: 'market-price', reason: 'retryable', error: '429' }],
      path: null
    } as unknown as GraphNode)
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('Incomplete')
  })
  it('rejects input values inconsistent with the selected child', () => {
    const { root, nodes } = fixture()
    root.path!.inputs[0].priceUsd = 2
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('mismatch')
  })
})
