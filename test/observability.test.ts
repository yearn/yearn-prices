import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureError } from '../src/observability'
import type { Env } from '../src/types'

function context(): ExecutionContext {
  return { waitUntil: vi.fn() } as unknown as ExecutionContext
}

async function pending(ctx: ExecutionContext): Promise<void> {
  await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0]
}

describe('captureError', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses a signal-specific Sentry endpoint without appending another path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = context()
    const env = {
      DATABASE_URL: 'postgres://x',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://o0.ingest.sentry.io/api/0/integration/otlp/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-sentry-auth=sentry sentry_key=public-key',
    } satisfies Env

    captureError(ctx, env, new Error('boom'))
    await pending(ctx)

    expect(fetchMock).toHaveBeenCalledWith(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, expect.objectContaining({
      headers: expect.objectContaining({ 'x-sentry-auth': 'sentry sentry_key=public-key' }),
    }))
  })

  it('appends the logs path to the generic OTLP base endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = context()

    captureError(ctx, {
      DATABASE_URL: 'postgres://x',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test/',
    }, new Error('boom'))
    await pending(ctx)

    expect(fetchMock.mock.calls[0][0]).toBe('https://collector.example.test/v1/logs')
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes).toEqual(
      expect.arrayContaining([
        { key: 'exception.type', value: { stringValue: 'Error' } },
        { key: 'exception.message', value: { stringValue: 'boom' } },
      ]),
    )
  })

  it('reports rejected exports without throwing into the request path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = context()

    captureError(ctx, {
      DATABASE_URL: 'postgres://x',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    }, new Error('boom'))
    await pending(ctx)

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('otel-export-error'))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('socket hang up'))
  })

  it('logs non-2xx export responses without throwing into the request path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = context()

    captureError(ctx, {
      DATABASE_URL: 'postgres://x',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
    }, new Error('boom'))
    await pending(ctx)

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('otel-export-error'))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('401'))
  })

  it('is a no-op when no OTLP endpoint is configured', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = context()

    captureError(ctx, { DATABASE_URL: 'postgres://x' }, new Error('boom'))

    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('percent-decodes OTLP header values and records an exact unix-nano timestamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123)
    const ctx = context()

    captureError(ctx, {
      DATABASE_URL: 'postgres://x',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-custom=foo%2Cbar',
    }, new Error('boom'))
    await pending(ctx)

    expect(fetchMock.mock.calls[0][1].headers['x-custom']).toBe('foo,bar')
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe(
      String(1_700_000_000_123n * 1_000_000n),
    )
  })
})
