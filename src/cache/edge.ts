function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default
}

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
    return raw
  }

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
  return edgeCache().match(cacheKey(request))
}

export function writeEdgeCache(ctx: ExecutionContext, request: Request, response: Response): void {
  ctx.waitUntil(edgeCache().put(cacheKey(request), response.clone()))
}
