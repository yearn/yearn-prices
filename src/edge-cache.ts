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

export async function readEdgeCache(request: Request): Promise<Response | undefined> {
  return edgeCache().match(request)
}

export function writeEdgeCache(ctx: ExecutionContext, request: Request, response: Response): void {
  if (!isEdgeCacheable(response)) {
    return
  }
  // Non-blocking: storing the response must not delay returning it to the client.
  ctx.waitUntil(edgeCache().put(request, response.clone()))
}

function isEdgeCacheable(response: Response): boolean {
  if (response.status !== 200) {
    return false
  }
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (/\b(no-store|private)\b/.test(cacheControl)) {
    return false
  }
  return /(?:s-)?max-age=(?!0\b)\d+/.test(cacheControl)
}
