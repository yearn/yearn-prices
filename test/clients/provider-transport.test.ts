import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJsonWithRetry, SlidingWindowRateLimiter } from '../../src/clients/http-client'
import { createProviderTransport, createProviderTransportFromEnv } from '../../src/clients/provider-transport'

describe('provider transport', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects non-provider URLs before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const transport = createProviderTransport({ fetchImpl })
    await expect(transport.fetch('https://example.invalid/')).rejects.toThrow('Provider host is not allowed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses a gateway and keeps provider authorization separate', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer gateway')
      expect(headers.get('x-provider-authorization')).toBe('Bearer enso')
      return Response.json({ ok: true })
    })
    const transport = createProviderTransport({
      gatewayUrl: 'https://gateway.example',
      gatewayToken: 'gateway',
      fetchImpl
    })
    await transport.fetch('https://api.enso.build/api/v1/prices/1/0x1', {
      headers: { authorization: 'Bearer enso' }
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('https://gateway.example/')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(encodeURIComponent('https://api.enso.build/'))
  })

  it.each([301, 302, 303, 307, 308])('rejects a %i redirect without forwarding gateway credentials', async (status) => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      status,
      headers: { location: 'https://untrusted.example/collect' }
    })
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      // Cloudflare rejects "error" at request construction, before network I/O.
      if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode')
      expect(init?.redirect).toBe('manual')
      return response
    })
    const transport = createProviderTransport({
      gatewayUrl: 'https://gateway.example',
      gatewayToken: 'gateway',
      fetchImpl
    })
    await expect(transport.fetch('https://coins.llama.fi/batchHistorical', { redirect: 'follow' })).rejects.toThrow(
      'Provider transport request failed'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).hostname).toBe('gateway.example')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('quarantines a timed-out route while preserving timeout diagnostics', async () => {
    const controller = new AbortController()
    const pool = { next: () => null, reportFailure: vi.fn(), reportSuccess: vi.fn() }
    const transport = createProviderTransport({
      pool,
      fetchImpl: vi.fn(async () => {
        controller.abort(new DOMException('timed out', 'TimeoutError'))
        throw controller.signal.reason
      }) as typeof fetch
    })
    await expect(
      transport.fetch('https://coins.llama.fi/prices/current/ethereum:token', {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(pool.reportFailure).toHaveBeenCalledWith(null)
  })

  it('waits for body validation and reports failures against the captured route', async () => {
    const pool = { next: () => null, reportFailure: vi.fn(), reportSuccess: vi.fn() }
    const transport = createProviderTransport({ pool, fetchImpl: vi.fn(async () => Response.json({})) as typeof fetch })
    const response = await transport.fetch('https://coins.llama.fi/prices/current/ethereum:token')
    expect(pool.reportSuccess).not.toHaveBeenCalled()
    transport.report(response, 'failure')
    transport.report(response, 'failure')
    expect(pool.reportFailure).toHaveBeenCalledTimes(1)
    expect(pool.reportFailure).toHaveBeenCalledWith(null)
  })

  it('quarantines a route when the caller signal times out during body parsing', async () => {
    const controller = new AbortController()
    const pool = { next: () => null, reportFailure: vi.fn(), reportSuccess: vi.fn() }
    const body = Response.json({ ok: true })
    body.json = () => {
      controller.abort(new DOMException('timed out', 'TimeoutError'))
      return Promise.reject(controller.signal.reason)
    }
    const transport = createProviderTransport({
      pool,
      fetchImpl: vi.fn(async () => body) as typeof fetch
    })

    await expect(
      fetchJsonWithRetry('https://coins.llama.fi/prices/current/ethereum:token', {
        service: 'Test',
        rateLimiter: new SlidingWindowRateLimiter(10, 1000),
        transport,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(pool.reportFailure).toHaveBeenCalledWith(null)
    expect(pool.reportSuccess).not.toHaveBeenCalled()
  })

  it('does not inherit process proxy settings for an explicit empty environment', () => {
    const previous = process.env.PRICE_PROXY_URLS
    process.env.PRICE_PROXY_URLS = 'http://1.2.3.4:8080'
    try {
      expect(createProviderTransportFromEnv({})).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.PRICE_PROXY_URLS
      else process.env.PRICE_PROXY_URLS = previous
    }
  })

  it('requires a gateway token when a gateway is configured', () => {
    expect(() => createProviderTransportFromEnv({ PRICE_GATEWAY_URL: 'https://gateway.example' })).toThrow(
      'Provider gateway requires PRICE_GATEWAY_TOKEN'
    )
  })
})
