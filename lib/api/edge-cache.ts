// Cloudflare edge caching via the Cache API.
//
// A worker-generated Response with a Cache-Control header only drives the
// client/browser cache — it never populates Cloudflare's edge cache on its own.
// To actually cache at the edge we have to read from and write to caches.default
// explicitly, keyed by the request URL.

// caches.default is a Cloudflare Workers extension absent from standard CacheStorage.
function edgeCache(): Cache | null {
  try {
    const storage = caches as unknown as { default?: Cache }
    return storage.default ?? null
  } catch {
    return null
  }
}

// caches.default keys on the request URL, so two logically identical requests that
// differ only in JSON ordering, whitespace, or token-address casing would fragment
// into separate cache entries. Canonicalize the URL before match/put so they collide.
export function canonicalCacheKey(rawUrl: string): string {
  const url = new URL(rawUrl)
  const coins = url.searchParams.get('coins')
  if (coins !== null) {
    url.searchParams.set('coins', canonicalizeCoins(coins))
  }
  url.searchParams.sort()
  return url.toString()
}

function canonicalizeCoins(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // not JSON — leave untouched; the handler will reject it.
  }
  // The spot payload is a top-level array of token-key strings — order is irrelevant,
  // so sort it. Batch/range payloads are objects keyed by token; their array *values*
  // (timestamp sets / [start, end]) are positional, so nested arrays are never reordered
  // — sorting them would collapse a valid [start, end] range onto its invalid mirror.
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map(canonicalizeValue).sort())
  }
  return JSON.stringify(canonicalizeValue(parsed))
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
  const cache = edgeCache()
  if (!cache) {
    return undefined
  }
  try {
    return (await cache.match(cacheKey(request))) ?? undefined
  } catch {
    // Local `next dev` / non-Worker runtimes may not support the Cache API.
    return undefined
  }
}

/**
 * Store a successful GET response in the edge cache.
 * `waitUntil` keeps put() off the response critical path when available (Workers).
 */
export function writeEdgeCache(
  request: Request,
  response: Response,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const cache = edgeCache()
  if (!cache) {
    return
  }

  // Trust the Cache API for the store/TTL decision: put() honors the response's
  // Cache-Control — it refuses no-store/private and derives the edge TTL from
  // s-maxage → max-age → Expires. Only success responses should reach this function.
  const put = cache.put(cacheKey(request), response.clone()).catch(error => {
    console.error(
      JSON.stringify({
        message: 'edge-cache-put-error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })

  if (waitUntil) {
    waitUntil(put)
  } else {
    void put
  }
}
