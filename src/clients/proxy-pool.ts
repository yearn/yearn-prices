import type { ProxyPoolLike } from './provider-transport'

/** A frequently refreshed public list; consumers must opt in explicitly. */
export const DEFAULT_PUBLIC_PROXY_LIST_URL =
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt'

const DEFAULT_REFRESH_TTL_MS = 15 * 60_000
const DEFAULT_FAILURE_COOLDOWN_MS = 60_000
const DEFAULT_LIST_TIMEOUT_MS = 5_000
const MAX_PROXY_LIST_BYTES = 1_000_000
const MAX_PROXIES = 512
const MAX_LIST_URLS = 4

export interface ProxyPoolOptions {
  proxies?: readonly string[]
  listUrls?: readonly string[]
  /** Do not enable this for production unless the risk of public proxies is accepted. */
  publicList?: boolean
  refreshTtlMs?: number
  failureCooldownMs?: number
  listTimeoutMs?: number
  maxListBytes?: number
  maxProxies?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface ProxyPoolEnvironment {
  PRICE_PROXY_URLS?: string
  PRICE_PROXY_LIST_URLS?: string
  PRICE_PROXY_PUBLIC_LIST?: string
}

interface RouteState {
  until: number
  failures: number
}

export class ProxyPoolExhaustedError extends Error {
  constructor() {
    super('No healthy provider proxy route is available')
    this.name = 'ProxyPoolExhaustedError'
  }
}

function splitValues(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((part) => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
}

function isPrivateIpv4(hostname: string): boolean {
  if (!isIpv4(hostname)) return false
  const [a, b, c] = hostname.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    // Documentation, benchmarking, multicast and future-use ranges are not
    // publicly routable proxy endpoints either.
    a >= 224 ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  )
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true
  }
  if (isPrivateIpv4(normalized)) return true
  // IPv6 loopback, link-local, unique-local and unspecified ranges. Prefix
  // checks apply only to IPv6; a public DNS name such as `fd.example` is not
  // a private literal by itself.
  return (
    normalized === '::1' ||
    normalized === '::' ||
    (normalized.includes(':') &&
      (normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')))
  )
}

/** Return a canonical proxy URL or null for malformed/private entries. */
export function normalizeProxy(value: string, options: { publicOnly?: boolean } = {}): string | null {
  let candidate = value.trim()
  if (!candidate) return null
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)) candidate = `http://${candidate}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (options.publicOnly && (parsed.username || parsed.password)) return null
  if (options.publicOnly && !isIpv4(parsed.hostname)) return null
  if (parsed.username || parsed.password) {
    // Credentials are accepted for operator-supplied pools. They are never
    // logged or included in errors; public list entries almost never use them.
  }
  if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

function parseProxyJson(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') result.push(entry)
    else if (entry && typeof entry === 'object') {
      const item = entry as { url?: unknown; ip?: unknown; host?: unknown; port?: unknown; protocol?: unknown }
      if (typeof item.url === 'string') result.push(item.url)
      else {
        const host = typeof item.ip === 'string' ? item.ip : typeof item.host === 'string' ? item.host : null
        const port = typeof item.port === 'number' || typeof item.port === 'string' ? String(item.port) : null
        if (host && port) result.push(`${typeof item.protocol === 'string' ? item.protocol : 'http'}://${host}:${port}`)
      }
    }
  }
  return result
}

function parseProxyList(body: string): string[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const jsonEntries = parseProxyJson(parsed)
    if (jsonEntries.length) return jsonEntries
  } catch {
    // Plain text is the format used by the default list.
  }
  return trimmed.split(/\r?\n/u).flatMap((line) => {
    const value = line.split('#', 1)[0]?.trim() ?? ''
    if (!value || /^\s*(?:proxy|ip(?: address)?|host)\s*[,;:]?/iu.test(value)) return []
    // CSV exports commonly include protocol, host and port columns. Keep the
    // simple host:port shape here; callers can supply URL-shaped entries.
    const fields = value.split(',').map((field) => field.trim())
    if (fields.length >= 2 && /^\d{1,5}$/u.test(fields[1] ?? '')) return [`http://${fields[0]}:${fields[1]}`]
    return [value]
  })
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('Proxy list response exceeds the configured size limit')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function validListUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !isPrivateHost(parsed.hostname) ? parsed.href : null
  } catch {
    return null
  }
}

function routeKey(proxy: string | null): string {
  return proxy ?? '<direct>'
}

/**
 * A small, in-memory circuit breaker for HTTP proxies. It deliberately does
 * not probe every public endpoint: a route is quarantined only after it
 * actually fails a provider request (or returns a provider/gateway 429/5xx).
 */
export class ProxyPool implements ProxyPoolLike {
  private proxies: string[]
  private readonly configuredProxies: string[]
  private currentRoute: string | null = null
  private rotateCurrentRoute = false
  private readonly failures = new Map<string, RouteState>()
  private refreshedAt = 0
  private refreshPromise: Promise<void> | undefined

  private readonly refreshTtlMs: number
  private readonly failureCooldownMs: number
  private readonly listTimeoutMs: number
  private readonly maxListBytes: number
  private readonly maxProxies: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly listUrls: string[]

  constructor(options: ProxyPoolOptions = {}) {
    this.refreshTtlMs = Math.max(1_000, options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS)
    this.failureCooldownMs = Math.max(1_000, options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS)
    this.listTimeoutMs = Math.max(500, options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS)
    this.maxListBytes = Math.max(1_024, options.maxListBytes ?? MAX_PROXY_LIST_BYTES)
    this.maxProxies = Math.max(1, Math.min(options.maxProxies ?? MAX_PROXIES, MAX_PROXIES))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.listUrls = [...(options.listUrls ?? []), ...(options.publicList ? [DEFAULT_PUBLIC_PROXY_LIST_URL] : [])]
      .slice(0, MAX_LIST_URLS)
      .map(validListUrl)
      .filter((value): value is string => value !== null)
    this.configuredProxies = this.canonicalize(options.proxies ?? [])
    this.proxies = [...this.configuredProxies]
  }

  next(): string | null {
    const routes: Array<string | null> = [null, ...this.proxies]
    if (!routes.length) return null
    const now = this.now()
    let currentIndex = routes.indexOf(this.currentRoute)
    if (currentIndex < 0) {
      // A refreshed list may remove the previously selected proxy. Restart at
      // the direct route rather than accidentally skipping it.
      this.currentRoute = null
      currentIndex = 0
    }
    const currentState = this.failures.get(routeKey(this.currentRoute))
    if (!this.rotateCurrentRoute && (!currentState || currentState.until <= now)) return this.currentRoute

    for (let offset = 1; offset <= routes.length; offset += 1) {
      const index = (currentIndex + offset) % routes.length
      const route = routes[index]
      const state = this.failures.get(routeKey(route))
      if (state && state.until > now) continue
      this.currentRoute = route
      this.rotateCurrentRoute = false
      return route
    }
    // Do not silently bypass a quarantined direct route. The caller can treat
    // this as a transient source failure and move to its next price source.
    throw new ProxyPoolExhaustedError()
  }

  reportFailure(proxy: string | null): void {
    // A provider cooldown can outlast this route's quarantine. Remember the
    // failure so the next attempt still changes route after that wait.
    if (proxy === this.currentRoute) this.rotateCurrentRoute = true
    const key = routeKey(proxy)
    const previous = this.failures.get(key)
    const failures = (previous?.failures ?? 0) + 1
    const multiplier = Math.min(8, 2 ** Math.max(0, failures - 1))
    this.failures.set(key, { failures, until: this.now() + this.failureCooldownMs * multiplier })
  }

  reportSuccess(proxy: string | null): void {
    // A late successful sibling must not erase an active quarantine.
    const state = this.failures.get(routeKey(proxy))
    if (!state || state.until <= this.now()) this.failures.delete(routeKey(proxy))
  }

  /** Refreshes configured sources once per TTL; concurrent callers coalesce. */
  async refresh(force = false): Promise<void> {
    const now = this.now()
    if (!force && this.refreshedAt > 0 && now - this.refreshedAt < this.refreshTtlMs) return
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.loadLists().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async loadLists(): Promise<void> {
    if (!this.listUrls.length) {
      this.refreshedAt = this.now()
      return
    }
    const responses = await Promise.allSettled(
      this.listUrls.map(async (url) => {
        const response = await this.fetchImpl(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(this.listTimeoutMs)
        })
        if (!response.ok) throw new Error(`Proxy list fetch failed with status ${response.status}`)
        return parseProxyList(await readBoundedBody(response, this.maxListBytes))
      })
    )
    const loaded = responses.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    if (loaded.length) {
      const publicProxies = this.canonicalize(loaded, true)
      // Operator supplied routes may use a hostname or credentials; only
      // downloaded entries go through the public-IP restriction.
      this.proxies = this.canonicalize([...this.configuredProxies, ...publicProxies])
    }
    this.refreshedAt = this.now()
  }

  private canonicalize(values: readonly string[], publicOnly = false): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of values) {
      const normalized = normalizeProxy(value, { publicOnly })
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      result.push(normalized)
      if (result.length >= this.maxProxies) break
    }
    return result
  }
}

export function createProxyPoolFromEnv(env: ProxyPoolEnvironment & Record<string, string | undefined> = {}): ProxyPool {
  const publicList = env.PRICE_PROXY_PUBLIC_LIST?.toLowerCase() === 'true'
  const listUrls = [...splitValues(env.PRICE_PROXY_LIST_URLS)]
  if (publicList) listUrls.push(DEFAULT_PUBLIC_PROXY_LIST_URL)
  return new ProxyPool({ proxies: splitValues(env.PRICE_PROXY_URLS), listUrls })
}

export {
  DEFAULT_FAILURE_COOLDOWN_MS,
  DEFAULT_LIST_TIMEOUT_MS,
  DEFAULT_REFRESH_TTL_MS,
  isPrivateHost,
  MAX_LIST_URLS,
  MAX_PROXIES,
  MAX_PROXY_LIST_BYTES,
  parseProxyList
}
