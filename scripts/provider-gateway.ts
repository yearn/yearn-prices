/**
 * Optional Bun gateway for the Cloudflare Worker.
 *
 * Workers cannot supply an HTTP CONNECT proxy in their native fetch runtime.
 * This operator-owned process accepts only an authenticated, allowlisted
 * HTTPS price-provider URL and forwards a GET through the rotating Bun proxy
 * pool. It is intentionally not a general-purpose proxy.
 *
 * Run locally with:
 *   PRICE_GATEWAY_TOKEN=... bun run scripts/provider-gateway.ts
 */
import { MAX_PROVIDER_COOLDOWN_MS, parseRetryAfter } from '../src/clients/http-client'
import {
  createProviderTransport,
  DEFAULT_ALLOWED_HOSTS,
  type ProviderTransport
} from '../src/clients/provider-transport'
import { createProxyPoolFromEnv } from '../src/clients/proxy-pool'

export const DEFAULT_GATEWAY_PORT = 8788
export const DEFAULT_GATEWAY_BIND = '127.0.0.1'
export const MAX_CONCURRENT_REQUESTS = 32
export const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024
export const UPSTREAM_TIMEOUT_MS = 8_000

export interface GatewayEnvironment extends Record<string, string | undefined> {
  PRICE_GATEWAY_TOKEN?: string
  PRICE_GATEWAY_PORT?: string
  PRICE_GATEWAY_HOST?: string
  PRICE_GATEWAY_BIND?: string
  PRICE_GATEWAY_REVISION?: string
  PRICE_PROXY_URLS?: string
  PRICE_PROXY_LIST_URLS?: string
  PRICE_PROXY_PUBLIC_LIST?: string
}

export interface GatewayConfig {
  token: string
  port: number
  hostname: string
}

export interface ProviderGatewayOptions {
  token: string
  transport: ProviderTransport
  revision?: string
  port?: number
  hostname?: string
  maxConcurrent?: number
  maxBodyBytes?: number
  upstreamTimeoutMs?: number
  now?: () => number
}

interface GatewayServerLike {
  stop?(closeActiveConnections?: boolean): Promise<void> | void
}

interface BunLike {
  serve(options: {
    port: number
    hostname: string
    fetch(request: Request): Response | Promise<Response>
  }): GatewayServerLike
}

function isValidBind(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !hasControlCharacter &&
    !/[\s/\\?#]/u.test(value) &&
    !value.includes('://')
  )
}

export function parseGatewayPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_GATEWAY_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PRICE_GATEWAY_PORT must be a valid port')
  }
  return port
}

export function parseGatewayBind(value: string | undefined): string {
  const bind = value?.trim() || DEFAULT_GATEWAY_BIND
  if (!isValidBind(bind)) throw new Error('PRICE_GATEWAY_BIND must be a valid hostname or IP address')
  return bind
}

export function gatewayConfigFromEnv(env: GatewayEnvironment = {}): GatewayConfig {
  const token = env.PRICE_GATEWAY_TOKEN?.trim()
  if (!token) throw new Error('PRICE_GATEWAY_TOKEN is required')
  if (token.length > 4096) throw new Error('PRICE_GATEWAY_TOKEN is too long')
  return {
    token,
    port: parseGatewayPort(env.PRICE_GATEWAY_PORT),
    hostname: parseGatewayBind(env.PRICE_GATEWAY_BIND ?? env.PRICE_GATEWAY_HOST)
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let difference = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after')
  return parseRetryAfter(value, MAX_PROVIDER_COOLDOWN_MS) ?? (response.status === 429 ? 60_000 : 5_000)
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
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
        throw new Error('upstream response exceeded the configured size limit')
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function allowedPath(target: URL): boolean {
  if (target.hostname === 'api.enso.build') {
    return target.pathname.startsWith('/api/v1/prices/') && target.pathname.length > '/api/v1/prices/'.length
  }
  if (target.hostname === 'coins.llama.fi') {
    return (
      target.pathname === '/batchHistorical' ||
      target.pathname.startsWith('/prices/') ||
      target.pathname.startsWith('/chart/') ||
      target.pathname.startsWith('/percentage/') ||
      target.pathname.startsWith('/block/')
    )
  }
  return false
}

export function allowedProviderTarget(raw: string | null): URL | null {
  if (!raw) return null
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return null
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.port ||
    target.hash ||
    !DEFAULT_ALLOWED_HOSTS.includes(target.hostname as (typeof DEFAULT_ALLOWED_HOSTS)[number]) ||
    !allowedPath(target)
  ) {
    return null
  }
  return target
}

function copyUpstreamHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of ['cache-control', 'content-type', 'date', 'etag', 'last-modified', 'retry-after']) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

function failure(status: number, retryAfter = 1): Response {
  return new Response('provider gateway unavailable', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(retryAfter) }
  })
}

/** Create a side-effect-free request handler for the gateway. */
export function createProviderGateway(options: ProviderGatewayOptions): (request: Request) => Promise<Response> {
  const port = options.port ?? DEFAULT_GATEWAY_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !options.token || options.token.length > 4096) {
    throw new Error('Provider gateway configuration is invalid')
  }
  const hostname = options.hostname ?? DEFAULT_GATEWAY_BIND
  if (!isValidBind(hostname)) throw new Error('Provider gateway bind address is invalid')

  const cooldownUntil = new Map<string, number>()
  const maxConcurrent = Math.max(1, Math.min(options.maxConcurrent ?? MAX_CONCURRENT_REQUESTS, MAX_CONCURRENT_REQUESTS))
  const maxBodyBytes = Math.max(1, Math.min(options.maxBodyBytes ?? MAX_UPSTREAM_BODY_BYTES, MAX_UPSTREAM_BODY_BYTES))
  const timeoutMs = Math.max(100, options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS)
  const now = options.now ?? (() => Date.now())
  let active = 0

  return async function handle(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url)
    if (requestUrl.pathname === '/healthz') {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
      return new Response('{"ok":true}\n', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })

    const suppliedToken = request.headers.get('authorization') ?? ''
    if (!constantTimeEqual(suppliedToken, `Bearer ${options.token}`))
      return new Response('unauthorized', { status: 401 })

    if (requestUrl.pathname === '/readyz') {
      return Response.json(
        { ok: true, revision: options.revision ?? 'development' },
        { headers: { 'cache-control': 'no-store' } }
      )
    }

    const target = allowedProviderTarget(requestUrl.searchParams.get('url'))
    if (!target) return new Response('invalid provider target', { status: 400 })

    const timestamp = now()
    const blockedUntil = cooldownUntil.get(target.hostname) ?? 0
    if (blockedUntil > timestamp) return failure(503, Math.max(1, Math.ceil((blockedUntil - timestamp) / 1_000)))
    if (active >= maxConcurrent) return failure(503, 1)

    const headers = new Headers()
    for (const name of ['accept', 'if-none-match', 'if-modified-since']) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (target.hostname === 'api.enso.build') {
      const providerAuthorization = request.headers.get('x-provider-authorization')
      if (providerAuthorization) headers.set('authorization', providerAuthorization)
    }

    active += 1
    let upstream: Response | undefined
    try {
      upstream = await options.transport.fetch(target, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if ([429, 502, 503, 504].includes(upstream.status)) {
        const until = now() + retryAfterMs(upstream)
        cooldownUntil.set(target.hostname, Math.max(cooldownUntil.get(target.hostname) ?? 0, until))
      }
      const body = await readBoundedBody(upstream, maxBodyBytes)
      if (upstream.ok) options.transport.report(upstream, 'success')
      const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
      return new Response([204, 205, 304].includes(upstream.status) ? null : bodyBuffer, {
        status: upstream.status,
        headers: copyUpstreamHeaders(upstream.headers)
      })
    } catch {
      if (upstream) options.transport.report(upstream, 'failure')
      return failure(502, 1)
    } finally {
      active -= 1
    }
  }
}

export function startProviderGateway(env: GatewayEnvironment = process.env): GatewayServerLike {
  const config = gatewayConfigFromEnv(env)
  const pool = createProxyPoolFromEnv(env)
  const transport = createProviderTransport({ pool, allowedHosts: DEFAULT_ALLOWED_HOSTS })
  void pool.refresh(true)
  const bun = (globalThis as typeof globalThis & { Bun?: BunLike }).Bun
  if (!bun) throw new Error('This gateway must run under Bun')
  const server = bun.serve({
    port: config.port,
    hostname: config.hostname,
    fetch: createProviderGateway({ ...config, transport, revision: env.PRICE_GATEWAY_REVISION })
  })
  if (typeof process !== 'undefined' && typeof process.once === 'function') {
    process.once('SIGTERM', () => void server.stop?.(true))
  }
  return server
}

const importMeta = import.meta as ImportMeta & { main?: boolean }
if (importMeta.main) startProviderGateway()
