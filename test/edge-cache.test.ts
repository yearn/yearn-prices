import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_PARTIAL,
  CACHE_CONTROL_TODAY,
  cacheControlForBatch,
  cacheControlForHistorical,
  cacheControlForRange,
  canonicalCacheKey,
  readEdgeCache,
  writeEdgeCache
} from '../src/cache'
import worker from '../src/index'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'

const BASE = 'https://svc/api/prices/spot'

function spotUrl(coins: unknown): string {
  return `${BASE}?coins=${encodeURIComponent(JSON.stringify(coins))}`
}

function batchUrl(path: string, coins: unknown, extra = ''): string {
  return `https://svc/api/prices/${path}?coins=${encodeURIComponent(JSON.stringify(coins))}${extra}`
}

describe('canonicalCacheKey', () => {
  it('ignores spot coin ordering', () => {
    const a = canonicalCacheKey(
      spotUrl([
        'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        'base:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
      ])
    )
    const b = canonicalCacheKey(
      spotUrl([
        'base:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
      ])
    )
    expect(a).toBe(b)
  })

  it('ignores token-address casing', () => {
    const lower = canonicalCacheKey(spotUrl(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const checksummed = canonicalCacheKey(spotUrl(['Ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']))
    expect(lower).toBe(checksummed)
  })

  it('ignores JSON whitespace', () => {
    const compact = canonicalCacheKey(
      `${BASE}?coins=${encodeURIComponent('["ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"]')}`
    )
    const spaced = canonicalCacheKey(
      `${BASE}?coins=${encodeURIComponent('[ "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" ]')}`
    )
    expect(compact).toBe(spaced)
  })

  it('ignores batch object key ordering and casing', () => {
    const a = canonicalCacheKey(
      batchUrl('batchHistorical', {
        'ethereum:0xAAA0000000000000000000000000000000000000': [1],
        'base:0xBBB0000000000000000000000000000000000000': [2]
      })
    )
    const b = canonicalCacheKey(
      batchUrl('batchHistorical', {
        'base:0xbbb0000000000000000000000000000000000000': [2],
        'ethereum:0xaaa0000000000000000000000000000000000000': [1]
      })
    )
    expect(a).toBe(b)
  })

  it('normalizes, sorts, and deduplicates batch timestamps by UTC day', () => {
    const dayOneMorning = 1695196800
    const dayOneEvening = 1695250000
    const dayTwoMorning = dayOneMorning + 86_400
    const token = 'ethereum:0xaaa0000000000000000000000000000000000000'
    const a = canonicalCacheKey(batchUrl('batchHistorical', { [token]: [dayTwoMorning, dayOneMorning, dayOneEvening] }))
    const b = canonicalCacheKey(
      batchUrl('batchHistorical', { [token]: [String(dayOneEvening), String(dayTwoMorning)] })
    )

    expect(a).toBe(b)
  })

  it('keeps batch timestamps from different UTC days distinct', () => {
    const token = 'ethereum:0xaaa0000000000000000000000000000000000000'
    const a = canonicalCacheKey(batchUrl('batchHistorical', { [token]: [1695196800] }))
    const b = canonicalCacheKey(batchUrl('batchHistorical', { [token]: [1695283200] }))

    expect(a).not.toBe(b)
  })

  it('ignores query-parameter ordering', () => {
    const coins = encodeURIComponent(JSON.stringify(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const a = canonicalCacheKey(`${BASE}?coins=${coins}&source=defillama`)
    const b = canonicalCacheKey(`${BASE}?source=defillama&coins=${coins}`)
    expect(a).toBe(b)
  })

  it('preserves positional range arrays (does not reorder [start, end])', () => {
    const a = canonicalCacheKey(
      batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [100, 200] })
    )
    const b = canonicalCacheKey(
      batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [200, 100] })
    )
    expect(a).not.toBe(b)
  })

  it('does not collapse a string-typed range onto its reversed (invalid) mirror', () => {
    // parseRangeCoins accepts string timestamps; a valid [start, end] must never share a
    // key with its start>end mirror, or a 400 could be served from the cached 200.
    const valid = canonicalCacheKey(
      batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ['100000', '200000'] })
    )
    const reversed = canonicalCacheKey(
      batchUrl('rangeHistorical', { 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ['200000', '100000'] })
    )
    expect(valid).not.toBe(reversed)
  })

  it('keeps distinct coins distinct', () => {
    const a = canonicalCacheKey(spotUrl(['ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    const b = canonicalCacheKey(spotUrl(['base:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']))
    expect(a).not.toBe(b)
  })
})

const TOKEN = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const PAST = 1695254399
const TODAY = normalizeToEndOfDay(Math.floor(Date.now() / 1000))

function stubEdgeCache() {
  const store = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response)
    })
  }
  vi.stubGlobal('caches', { default: cache })
  return { cache, store }
}

describe('readEdgeCache / writeEdgeCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads and writes under the canonical key, not the raw url', async () => {
    const { cache, store } = stubEdgeCache()
    const waitUntil = vi.fn()
    const ctx = { waitUntil } as unknown as ExecutionContext
    const written = new Request(spotUrl(['Ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2']))

    writeEdgeCache(ctx, written, new Response('{"coins":{}}'))
    await waitUntil.mock.calls[0][0]

    expect([...store.keys()]).toEqual([canonicalCacheKey(written.url)])
    const hit = await readEdgeCache(new Request(spotUrl([TOKEN])))
    expect(hit).toBeDefined()
    await expect(hit!.text()).resolves.toBe('{"coins":{}}')
    expect(cache.match).toHaveBeenCalledOnce()
  })

  it('misses for a different request', async () => {
    stubEdgeCache()
    await expect(readEdgeCache(new Request(spotUrl([TOKEN])))).resolves.toBeUndefined()
  })

  it('writes a clone so the original response body stays readable', async () => {
    const { store } = stubEdgeCache()
    const waitUntil = vi.fn()
    const ctx = { waitUntil } as unknown as ExecutionContext
    const request = new Request(spotUrl([TOKEN]))
    const response = new Response('{"coins":{}}')

    writeEdgeCache(ctx, request, response)
    await waitUntil.mock.calls[0][0]

    await expect(response.text()).resolves.toBe('{"coins":{}}')
    await expect(store.get(canonicalCacheKey(request.url))!.text()).resolves.toBe('{"coins":{}}')
  })
})

describe('validation before the edge-cache read', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rejects an over-limit batch payload without consulting the cache', async () => {
    const { cache } = stubEdgeCache()
    const coins = { [TOKEN]: Array.from({ length: 91 }, () => PAST) }
    const request = new Request(batchUrl('batchHistorical', coins), {
      headers: { authorization: 'Bearer k' }
    })

    const response = await worker.fetch(
      request,
      { API_KEY_TEST: 'k' } as unknown as Env,
      {
        waitUntil: vi.fn()
      } as unknown as ExecutionContext
    )

    expect(response.status).toBe(400)
    expect(cache.match).not.toHaveBeenCalled()
  })
})

describe('cache-control policies', () => {
  it('marks a settled past day immutable and today short-lived', () => {
    expect(cacheControlForHistorical(PAST)).toBe(CACHE_CONTROL_IMMUTABLE)
    expect(cacheControlForHistorical(TODAY)).toBe(CACHE_CONTROL_TODAY)
  })

  it('downgrades an incomplete batch to partial and lets today win', () => {
    expect(cacheControlForBatch([PAST], true)).toBe(CACHE_CONTROL_IMMUTABLE)
    expect(cacheControlForBatch([PAST], false)).toBe(CACHE_CONTROL_PARTIAL)
    expect(cacheControlForBatch([PAST, TODAY], true)).toBe(CACHE_CONTROL_TODAY)
    expect(cacheControlForBatch([PAST, TODAY], false)).toBe(CACHE_CONTROL_TODAY)
  })

  it('applies the same rules to ranges', () => {
    expect(cacheControlForRange([PAST], true)).toBe(CACHE_CONTROL_IMMUTABLE)
    expect(cacheControlForRange([PAST], false)).toBe(CACHE_CONTROL_PARTIAL)
    expect(cacheControlForRange([TODAY], true)).toBe(CACHE_CONTROL_TODAY)
  })
})
