import { Container, getContainer } from '@cloudflare/containers'

const CONTAINER_NAME = 'provider-gateway'
const CONTAINER_PORT = 8788
const MAX_TOKEN_LENGTH = 4_096
type GatewayContainerContext = ConstructorParameters<typeof Container>[0]

export interface GatewayEnv {
  PROVIDER_GATEWAY: DurableObjectNamespace<ProviderGatewayContainer>
  PRICE_GATEWAY_TOKEN?: string
  PRICE_PROXY_URLS?: string
  PRICE_PROXY_LIST_URLS?: string
  PRICE_PROXY_PUBLIC_LIST?: string
}

/**
 * The single named container owns the proxy pool and provider cooldowns.
 *
 * This state intentionally lives in the process, so it is shared by all
 * requests routed to this name but is lost when Cloudflare replaces or sleeps
 * the instance. The next request starts a fresh pool and refreshes configured
 * lists; the one-hour idle window covers the gateway's normal cooldowns.
 */
export class ProviderGatewayContainer extends Container<GatewayEnv> {
  defaultPort = CONTAINER_PORT
  sleepAfter = '1h'
  enableInternet = true

  constructor(ctx: GatewayContainerContext, env: GatewayEnv) {
    super(ctx, env)

    const token = env.PRICE_GATEWAY_TOKEN?.trim()
    // Port and bind address are non-secret image defaults. Keep the runtime
    // envVars surface limited to the token and proxy configuration only.
    const envVars: Record<string, string> = {}
    if (token && token.length <= MAX_TOKEN_LENGTH) envVars.PRICE_GATEWAY_TOKEN = token

    for (const key of ['PRICE_PROXY_URLS', 'PRICE_PROXY_LIST_URLS', 'PRICE_PROXY_PUBLIC_LIST'] as const) {
      const value = env[key]
      if (typeof value === 'string' && value.trim() !== '') envVars[key] = value
    }
    this.envVars = envVars
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

function unavailable(): Response {
  return new Response('gateway unavailable', {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }
  })
}

function unauthorized(): Response {
  return new Response('unauthorized', {
    status: 401,
    headers: { 'cache-control': 'no-store', 'www-authenticate': 'Bearer' }
  })
}

function configuredToken(env: GatewayEnv): string | null {
  const token = env.PRICE_GATEWAY_TOKEN?.trim()
  if (!token || token.length > MAX_TOKEN_LENGTH) return null
  return token
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    // Authenticate before resolving the Durable Object. A missing or invalid
    // secret therefore cannot start the container or reveal its state.
    const token = configuredToken(env)
    if (!token) return unavailable()
    if (!constantTimeEqual(request.headers.get('authorization') ?? '', `Bearer ${token}`)) {
      return unauthorized()
    }

    try {
      const container = getContainer(env.PROVIDER_GATEWAY, CONTAINER_NAME)
      // Health and revision readiness are handled by Bun without provider
      // traffic. /readyz also validates the token inside the container.
      return await container.fetch(request)
    } catch {
      // Keep platform/container details and environment values out of errors.
      return unavailable()
    }
  }
}
