import { describe, expect, it } from 'vitest'
import { validateGraphResolution } from '../../src/backfill/graph-validation'
import type { GraphNode } from '../../src/sources/onchain/graph'
import { parseManifest } from '../../src/backfill/manifest'

const timestamp = 1704067199
const token = '0x1111111111111111111111111111111111111111'
const childToken = '0x2222222222222222222222222222222222222222'
const target = parseManifest(
  JSON.stringify({ version: 1, targets: [{ chainId: 1, token, eodTimestamp: timestamp }] })
).targets[0]
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
  it.each([-43200, 43200])('accepts the 12-hour boundary %s', (offset) => {
    const { root, child, nodes } = fixture()
    child.path!.observedTimestamp += offset
    root.path!.inputs[0].observedTimestamp += offset
    expect(validateGraphResolution(root, target, nodes).price).toBe(1)
  })
  it('rejects a late child even when the root timestamp is in range', () => {
    const { root, child, nodes } = fixture()
    child.path!.observedTimestamp += 43201
    root.path!.inputs[0].observedTimestamp += 43201
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('12-hour')
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
  it('rejects input values inconsistent with the selected child', () => {
    const { root, nodes } = fixture()
    root.path!.inputs[0].priceUsd = 2
    expect(() => validateGraphResolution(root, target, nodes)).toThrow('mismatch')
  })
})
