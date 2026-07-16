import { describe, expect, it } from 'vitest'
import { canonicalCacheKey } from '@/lib/api/edge-cache'

const BASE = 'https://svc/api/prices/spot'

function spotUrl(coins: unknown): string {
  return `${BASE}?coins=${encodeURIComponent(JSON.stringify(coins))}`
}

function batchUrl(path: string, coins: unknown, extra = ''): string {
  return `https://svc/api/prices/${path}?coins=${encodeURIComponent(JSON.stringify(coins))}${extra}`
}

describe('canonicalCacheKey', () => {
  it('ignores spot coin ordering', () => {
    const a = canonicalCacheKey(spotUrl(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'base:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const b = canonicalCacheKey(spotUrl(['base:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    expect(a).toBe(b)
  })

  it('ignores token-address casing', () => {
    const lower = canonicalCacheKey(spotUrl(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const checksummed = canonicalCacheKey(spotUrl(['Ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']))
    expect(lower).toBe(checksummed)
  })

  it('ignores JSON whitespace', () => {
    const compact = canonicalCacheKey(`${BASE}?coins=${encodeURIComponent('["ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]')}`)
    const spaced = canonicalCacheKey(`${BASE}?coins=${encodeURIComponent('[ "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" ]')}`)
    expect(compact).toBe(spaced)
  })

  it('ignores batch object key ordering and casing', () => {
    const a = canonicalCacheKey(batchUrl('batchHistorical', { 'ethereum:0xAAA0000000000000000000000000000000000000': [1], 'base:0xBBB0000000000000000000000000000000000000': [2] }))
    const b = canonicalCacheKey(batchUrl('batchHistorical', { 'base:0xbbb0000000000000000000000000000000000000': [2], 'ethereum:0xaaa0000000000000000000000000000000000000': [1] }))
    expect(a).toBe(b)
  })

  it('ignores query-parameter ordering', () => {
    const coins = encodeURIComponent(JSON.stringify(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const a = canonicalCacheKey(`${BASE}?coins=${coins}&source=defillama`)
    const b = canonicalCacheKey(`${BASE}?source=defillama&coins=${coins}`)
    expect(a).toBe(b)
  })

  it('preserves positional range arrays (does not reorder [start, end])', () => {
    const a = canonicalCacheKey(batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [100, 200] }))
    const b = canonicalCacheKey(batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [200, 100] }))
    expect(a).not.toBe(b)
  })
})
