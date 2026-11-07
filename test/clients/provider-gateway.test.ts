import { describe, expect, it, vi } from 'vitest'
import {
  createProviderGateway,
  gatewayConfigFromEnv,
  parseGatewayBind,
  parseGatewayPort
} from '../../scripts/provider-gateway'
import type { ProviderTransport } from '../../src/clients/provider-transport'

const TOKEN = 'gateway-secret'
const LLAMA_TARGET = 'https://coins.llama.fi/prices/current/ethereum:0x0000000000000000000000000000000000000001'

function transport(responses: Response[]): ProviderTransport & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => {
      const response = responses.shift()
      if (!response) throw new Error('unexpected upstream request')
      return response
    }),
    report: vi.fn(),
    reportError: vi.fn()
  }
}

function request(target: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://gateway.test/?url=${encodeURIComponent(target)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, ...headers }
  })
}

describe('provider gateway', () => {
  it('parses and validates bind settings', () => {
    expect(parseGatewayPort(undefined)).toBe(8788)
    expect(parseGatewayPort('9000')).toBe(9000)
    expect(parseGatewayBind('0.0.0.0')).toBe('0.0.0.0')
    expect(() => parseGatewayPort('0')).toThrow()
    expect(() => parseGatewayBind('https://0.0.0.0')).toThrow()
    expect(gatewayConfigFromEnv({ PRICE_GATEWAY_TOKEN: TOKEN })).toMatchObject({ token: TOKEN, port: 8788 })
  })

  it('serves health checks without authentication or upstream traffic', async () => {
    const upstream = transport([])
    const handle = createProviderGateway({ token: TOKEN, transport: upstream })
    const response = await handle(new Request('https://gateway.test/healthz'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(upstream.fetch).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated, non-price, and non-GET requests', async () => {
    const upstream = transport([])
    const handle = createProviderGateway({ token: TOKEN, transport: upstream })
    expect((await handle(new Request(`https://gateway.test/?url=${encodeURIComponent(LLAMA_TARGET)}`))).status).toBe(
      401
    )
    expect((await handle(request('https://coins.llama.fi/protocols'))).status).toBe(400)
    expect(
      (await handle(new Request(`https://gateway.test/?url=${encodeURIComponent(LLAMA_TARGET)}`, { method: 'POST' })))
        .status
    ).toBe(405)
    expect(upstream.fetch).not.toHaveBeenCalled()
  })

  it('forwards an allowlisted target and preserves provider status/body headers', async () => {
    const upstream = transport([Response.json({ coins: {} }, { status: 429, headers: { 'retry-after': '30' } })])
    const handle = createProviderGateway({ token: TOKEN, transport: upstream })
    const response = await handle(request(LLAMA_TARGET))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.json()).toEqual({ coins: {} })
    expect(upstream.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'coins.llama.fi' }),
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    )
  })

  it('applies a shared cooldown after a rate limit', async () => {
    let now = 1_000
    const upstream = transport([Response.json({ ok: true }, { status: 429, headers: { 'retry-after': '30' } })])
    const handle = createProviderGateway({ token: TOKEN, transport: upstream, now: () => now })
    expect((await handle(request(LLAMA_TARGET))).status).toBe(429)
    expect((await handle(request(LLAMA_TARGET))).status).toBe(503)
    now += 31_000
    expect((await handle(request(LLAMA_TARGET))).status).toBe(502)
  })

  it('bounds response bodies while retaining the active request slot', async () => {
    const upstream = transport([new Response('too-large')])
    const handle = createProviderGateway({ token: TOKEN, transport: upstream, maxBodyBytes: 3 })
    const response = await handle(request(LLAMA_TARGET))
    expect(response.status).toBe(502)
    expect(upstream.report).toHaveBeenCalledWith(expect.any(Response), 'failure')
  })
})
