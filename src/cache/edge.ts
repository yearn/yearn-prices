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
  return edgeCache().match(cacheKey(request))
}

export function writeEdgeCache(ctx: ExecutionContext, request: Request, response: Response): void {
  // Trust the Cache API for the store/TTL decision: put() honors the response's
  // Cache-Control — it refuses no-store/private and derives the edge TTL from
  // s-maxage → max-age → Expires. Only success responses reach this function (the
  // request handler returns errors straight from its catch block), so the edge stores
  // successes and nothing else; put() honoring Cache-Control is the backstop.
  //
  // Non-blocking: storing the response must not delay returning it to the client.
  ctx.waitUntil(edgeCache().put(cacheKey(request), response.clone()))
}
