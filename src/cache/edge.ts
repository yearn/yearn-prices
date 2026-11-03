import * as Sentry from '@sentry/cloudflare'
import type { Env } from '../types'

// Bumping this revision invalidates prior historical cache entries, including
// arbitrary batch/range combinations and source filters.
export const HISTORICAL_CACHE_REVISION = '2026-11-cache-integrity-v2'

// Cloudflare edge caching via the Cache API.
//
// A worker-generated Response with a Cache-Control header only drives the
// client/browser cache — it never populates Cloudflare's edge cache on its own.
// To actually cache at the edge we have to read from and write to caches.default
// explicitly, keyed by the request URL.

// caches.default is a Cloudflare Workers extension absent from the WebWorker lib's CacheStorage.
function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default
}

// caches.default keys on the request URL, so two logically identical requests that
// differ only in JSON ordering, whitespace, or token-address casing would fragment
// into separate cache entries. Canonicalize the URL before match/put so they collide.
export function canonicalCacheKey(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (
    url.pathname.startsWith('/api/prices/historical/') ||
    url.pathname === '/api/prices/batchHistorical' ||
    url.pathname === '/api/prices/rangeHistorical'
  ) {
    url.searchParams.set('_price_cache_revision', HISTORICAL_CACHE_REVISION)
  }
  const coins = url.searchParams.get('coins')
  if (coins !== null) {
    url.searchParams.set('coins', canonicalizeCoins(coins, url.pathname))
  }
  url.searchParams.sort()
  return url.toString()
}

function canonicalizeCoins(raw: string, pathname: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // not JSON — leave untouched; the handler will reject it.
  }

  // The spot payload is a top-level array of token-key strings, so sort it.
  // Batch timestamp arrays are sets and are normalized separately by UTC day.
  // Range [start, end] arrays stay positional: sorting them would collapse a
  // valid range onto its invalid mirror.
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map(canonicalizeValue).sort())
  }
  if (pathname === '/api/prices/batchHistorical') {
    return JSON.stringify(canonicalizeBatchValue(parsed))
  }
  return JSON.stringify(canonicalizeValue(parsed))
}

function canonicalizeBatchValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return canonicalizeValue(value)
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const timestamps = (value as Record<string, unknown>)[key]
    if (!Array.isArray(timestamps)) {
      out[key.toLowerCase()] = canonicalizeValue(timestamps)
      continue
    }
    const normalized: number[] = []
    let valid = true
    for (const timestamp of timestamps) {
      if (!(typeof timestamp === 'number' || /^\d+$/.test(String(timestamp)))) {
        valid = false
        break
      }
      const numeric = Number(timestamp)
      if (!Number.isFinite(numeric)) {
        valid = false
        break
      }
      normalized.push(Math.floor(numeric / 86_400) * 86_400 + 86_399)
    }
    out[key.toLowerCase()] = valid
      ? [...new Set(normalized)].sort((left, right) => left - right)
      : canonicalizeValue(timestamps)
  }
  return out
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key.toLowerCase()] = canonicalizeValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  if (typeof value === 'string') {
    return value.toLowerCase()
  }
  return value
}

function cacheKey(request: Request): Request {
  return new Request(canonicalCacheKey(request.url), { method: request.method })
}

export async function readEdgeCache(request: Request): Promise<Response | undefined> {
  const response = await edgeCache().match(cacheKey(request))
  if (!response) {
    return undefined
  }

  // The key deliberately shares entries across address casing. Restore the exact
  // response keys requested by this caller so a warm hit has the same shape as a
  // cold route execution.
  return rekeyCoinsForRequest(response, request)
}

async function rekeyCoinsForRequest(response: Response, request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (
    url.pathname !== '/api/prices/spot' &&
    url.pathname !== '/api/prices/batchHistorical' &&
    url.pathname !== '/api/prices/rangeHistorical'
  ) {
    return response
  }

  const coinsRaw = url.searchParams.get('coins')
  if (coinsRaw === null) {
    return response
  }

  let parsedRequest: unknown
  let parsedResponse: unknown
  try {
    parsedRequest = JSON.parse(coinsRaw)
    parsedResponse = await response.clone().json()
  } catch {
    return response
  }

  const requestedKeys = new Map<string, string>()
  if (Array.isArray(parsedRequest)) {
    for (const key of parsedRequest) {
      if (typeof key === 'string' && !requestedKeys.has(key.toLowerCase())) {
        requestedKeys.set(key.toLowerCase(), key)
      }
    }
  } else if (parsedRequest && typeof parsedRequest === 'object') {
    for (const key of Object.keys(parsedRequest)) {
      if (!requestedKeys.has(key.toLowerCase())) {
        requestedKeys.set(key.toLowerCase(), key)
      }
    }
  }

  if (!parsedResponse || typeof parsedResponse !== 'object' || !('coins' in parsedResponse)) {
    return response
  }
  const body = parsedResponse as { coins?: unknown; [key: string]: unknown }
  if (!body.coins || typeof body.coins !== 'object' || Array.isArray(body.coins)) {
    return response
  }

  const coins: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body.coins)) {
    coins[requestedKeys.get(key.toLowerCase()) ?? key] = value
  }
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(JSON.stringify({ ...body, coins }), {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

export function writeEdgeCache(ctx: ExecutionContext, _env: Env, request: Request, response: Response): void {
  // Cache.put() derives edge TTL from s-maxage → max-age → Expires. Spot can return
  // HTTP 200 with a per-token transient error, so explicitly skip no-store responses
  // before handing them to Cache API.
  //
  // Non-blocking: storing the response must not delay returning it to the client.
  if (/(^|,)\s*no-store\b/i.test(response.headers.get('cache-control') ?? '')) {
    return
  }

  ctx.waitUntil(
    edgeCache()
      .put(cacheKey(request), response.clone())
      .catch((error: unknown) => {
        Sentry.captureException(error)
      })
  )
}
