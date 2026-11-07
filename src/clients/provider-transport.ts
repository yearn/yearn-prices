import { createProxyPoolFromEnv } from './proxy-pool'

/**
 * Fetch transport primitives used by provider clients.
 *
 * The Worker runtime only has direct `fetch`; Bun additionally supports a
 * native `proxy` fetch option.  Keeping the option behind this interface lets
 * the retrying HTTP client rotate a route after an upstream 429/503 without
 * putting Bun-only globals into the Worker bundle.
 */

export interface ProviderTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  /** Report only after consuming the body; 2xx headers alone are not success. */
  report(response: Response, outcome?: 'success' | 'failure'): void
  /** Mark the route used for a failed request as unhealthy. */
  reportError(error: unknown): void
}

export interface ProviderTransportOptions {
  /** Optional proxy pool. If omitted, requests use direct fetch. */
  pool?: ProxyPoolLike
  /** A gateway URL is used by Cloudflare Workers when direct proxying is not available. */
  gatewayUrl?: string
  /** Secret sent to an operator-owned gateway. */
  gatewayToken?: string
  /** Restrict requests sent through this transport to known upstream hosts. */
  allowedHosts?: readonly string[]
  /** Inject a fetch implementation for tests. */
  fetchImpl?: typeof fetch
}

export interface ProviderTransportEnvironment extends Record<string, string | undefined> {
  PRICE_GATEWAY_URL?: string
  PRICE_GATEWAY_TOKEN?: string
  PRICE_PROXY_URLS?: string
  PRICE_PROXY_LIST_URLS?: string
  PRICE_PROXY_PUBLIC_LIST?: string
}

export interface ProxyPoolLike {
  next(): string | null
  reportFailure(proxy: string | null): void
  reportSuccess(proxy: string | null): void
  refresh?(force?: boolean): Promise<void>
}

const DEFAULT_ALLOWED_HOSTS = ['coins.llama.fi', 'api.enso.build'] as const
const envTransportCache = new WeakMap<object, ProviderTransport>()

function urlFor(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href)
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

function copyInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return { redirect: 'error' }
  const headers = init.headers === undefined ? undefined : new Headers(init.headers)
  // Provider clients never follow redirects, including redirects returned by
  // a malicious proxy or a compromised list endpoint.
  return { ...init, redirect: 'error', ...(headers ? { headers } : {}) }
}

function isBunRuntime(): boolean {
  // Do not import `Bun`: doing so makes Wrangler include a Node compatibility
  // shim and fails in a Worker.  The marker is available in Bun's runtime.
  return typeof process !== 'undefined' && process.versions?.bun !== undefined
}

function isAllowedHost(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some((allowed) => normalized === allowed.toLowerCase().replace(/\.$/, ''))
}

function gatewayTargetUrl(gatewayUrl: string, target: URL): URL {
  const gateway = new URL(gatewayUrl)
  if (gateway.protocol !== 'https:') {
    throw new Error('Provider gateway must use HTTPS')
  }
  gateway.searchParams.set('url', target.href)
  return gateway
}

/**
 * Creates a transport that selects one proxy from `pool` for each call.
 *
 * Bun's native fetch accepts a `proxy` option. Cloudflare Workers cannot open
 * arbitrary CONNECT tunnels, so they use an authenticated HTTPS gateway that
 * performs the proxying server-side. The gateway receives only a validated
 * provider URL and a GET request; callers must still pass an allowlist.
 */
export function createProviderTransport(options: ProviderTransportOptions = {}): ProviderTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS
  if (options.gatewayUrl && !options.gatewayToken) {
    throw new Error('Provider gateway requires PRICE_GATEWAY_TOKEN')
  }
  const reportedResponses = new WeakSet<Response>()
  const responseRoutes = new WeakMap<Response, string | null>()
  const reportedErrors = new WeakSet<object>()

  return {
    async fetch(input, init) {
      const target = urlFor(input)
      if (target.protocol !== 'https:') {
        throw new Error('Provider requests must use HTTPS')
      }
      if (target.username || target.password || target.port) {
        throw new Error('Provider URL must not contain credentials or a non-default port')
      }
      if (!isAllowedHost(target.hostname, allowedHosts)) {
        throw new Error('Provider host is not allowed')
      }

      // The gateway owns proxy selection. A Worker must never quarantine a
      // local route merely because the remote relay returned a provider 503.
      const proxy = options.gatewayUrl ? null : (options.pool?.next() ?? null)
      const requestInit = copyInit(init) ?? {}
      let requestInput: RequestInfo | URL = input
      if (options.gatewayUrl) {
        requestInput = gatewayTargetUrl(options.gatewayUrl, target)
        const headers = new Headers(requestInit.headers)
        headers.set('x-provider-target', target.hostname)
        const providerAuthorization = headers.get('authorization')
        if (providerAuthorization) {
          // The gateway's bearer token is intentionally separate from Enso's
          // provider credential. It forwards this value only to api.enso.build.
          headers.set('x-provider-authorization', providerAuthorization)
        }
        if (options.gatewayToken) headers.set('authorization', `Bearer ${options.gatewayToken}`)
        requestInit.headers = headers
      } else if (proxy && isBunRuntime()) {
        // Bun's RequestInit has this field at runtime, but it is intentionally
        // absent from the WebWorker lib used by the Worker build.
        ;(requestInit as RequestInit & { proxy?: string }).proxy = proxy
      }

      try {
        const response = await fetchImpl(requestInput, requestInit)
        responseRoutes.set(response, proxy)
        if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
          options.pool?.reportFailure(proxy)
          reportedResponses.add(response)
          const refresh = options.pool?.refresh?.()
          if (refresh) void refresh.catch(() => undefined)
        }
        return response
      } catch (error) {
        const errorName = (error as { name?: string } | null)?.name
        const timeout = errorName === 'TimeoutError' || init?.signal?.reason?.name === 'TimeoutError'
        const callerCancelled = !timeout && (init?.signal?.aborted || errorName === 'AbortError')
        if (!callerCancelled) options.pool?.reportFailure(proxy)
        if (typeof error === 'object' && error !== null) reportedErrors.add(error)
        // Do not expose proxy credentials or provider query strings through a
        // transport exception. Caller cancellation remains distinguishable.
        if (callerCancelled) throw error
        if (timeout) throw new DOMException('Provider transport timed out', 'TimeoutError')
        throw new Error('Provider transport request failed')
      }
    },
    report(response, outcome) {
      if (!responseRoutes.has(response) || reportedResponses.has(response)) return
      const route = responseRoutes.get(response)!
      if (outcome === 'success') options.pool?.reportSuccess(route)
      else if (outcome === 'failure' || [429, 502, 503, 504].includes(response.status))
        options.pool?.reportFailure(route)
      else return
      reportedResponses.add(response)
    },
    reportError(error) {
      // fetch() already quarantines the exact route it selected. If a caller
      // reports a transport error after catching it, do not mark an unrelated
      // concurrent request's route as failed.
      if (typeof error !== 'object' || error === null || reportedErrors.has(error)) return
      // There is no safe route identity for an error created outside fetch;
      // deliberately leave the pool unchanged.
    }
  }
}

/**
 * Build the optional transport from Worker/Bun bindings. Direct fetch remains
 * the default. In a Worker, a gateway is required because the runtime cannot
 * open arbitrary HTTP CONNECT tunnels; Bun can use the native proxy option.
 */
export function createProviderTransportFromEnv(env?: ProviderTransportEnvironment): ProviderTransport | undefined {
  // Omitted env means a Bun/Node job should read process.env. An explicitly
  // supplied (even empty) Worker binding object is authoritative and must not
  // inherit secrets or proxy settings from a Node compatibility shim.
  const runtimeEnv = env ?? (typeof process !== 'undefined' ? (process.env as ProviderTransportEnvironment) : {})
  const gatewayUrl = runtimeEnv.PRICE_GATEWAY_URL?.trim()
  const hasProxyConfiguration = Boolean(
    runtimeEnv.PRICE_PROXY_URLS?.trim() ||
      runtimeEnv.PRICE_PROXY_LIST_URLS?.trim() ||
      runtimeEnv.PRICE_PROXY_PUBLIC_LIST?.toLowerCase() === 'true'
  )
  if (!gatewayUrl && !hasProxyConfiguration) return undefined
  if (!gatewayUrl && !isBunRuntime()) {
    throw new Error('Proxy rotation requires PRICE_GATEWAY_URL in a non-Bun runtime')
  }

  const cached = envTransportCache.get(runtimeEnv)
  if (cached) return cached

  // Value import is safe: proxy-pool imports ProxyPoolLike as a type only.
  // Keep one pool per environment object so source factories share health and
  // refresh state rather than creating a list fetch for every request.
  const pool = gatewayUrl ? undefined : createProxyPoolFromEnv(runtimeEnv)
  if (pool) void pool.refresh()
  const transport = createProviderTransport({
    pool,
    gatewayUrl,
    gatewayToken: runtimeEnv.PRICE_GATEWAY_TOKEN
  })
  envTransportCache.set(runtimeEnv, transport)
  return transport
}

export { DEFAULT_ALLOWED_HOSTS, isAllowedHost }
