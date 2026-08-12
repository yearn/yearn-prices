import type { Env } from './types'

// Cloudflare Workers can't run the OpenTelemetry Node SDK, so errors are sent as
// OTLP/HTTP JSON log records via fetch. Vendor-neutral: point
// OTEL_EXPORTER_OTLP_ENDPOINT at any OTLP backend (Sentry OTLP, Grafana, a Collector, ...).
const SERVICE_NAME = 'yearn-prices'
const SEVERITY_ERROR = 17 // OTLP severityNumber for ERROR

type OtlpAttribute = { key: string; value: { stringValue: string } }

function attr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

// OTEL_EXPORTER_OTLP_HEADERS format: "key1=value1,key2=value2".
function parseHeaders(raw?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!raw) return headers
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return headers
}

function buildPayload(serviceName: string, err: Error): unknown {
  const attributes = [attr('exception.type', err.name), attr('exception.message', err.message)]
  if (err.stack) attributes.push(attr('exception.stacktrace', err.stack))

  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', serviceName)] },
        scopeLogs: [
          {
            scope: { name: serviceName },
            logRecords: [
              {
                timeUnixNano: String(Date.now() * 1_000_000),
                severityNumber: SEVERITY_ERROR,
                severityText: 'ERROR',
                body: { stringValue: err.message },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  }
}

export function captureError(ctx: ExecutionContext, env: Env, error: unknown): void {
  const logsEndpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  const endpoint = logsEndpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return

  const err = error instanceof Error ? error : new Error(String(error))
  const normalizedEndpoint = endpoint.replace(/\/$/, '')
  const url = logsEndpoint ? normalizedEndpoint : `${normalizedEndpoint}/v1/logs`
  const body = JSON.stringify(buildPayload(env.OTEL_SERVICE_NAME || SERVICE_NAME, err))

  // waitUntil lets the export finish after the response is returned (no added latency).
  ctx.waitUntil(
    fetch(url, {
      method: 'POST',
      headers: parseHeaders(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
      body,
    }).then((response) => {
      if (!response.ok) {
        console.error(JSON.stringify({
          message: 'otel-export-error',
          status: response.status,
        }))
      }
    }).catch((exportError) => {
      console.error(JSON.stringify({
        message: 'otel-export-error',
        error: exportError instanceof Error ? exportError.message : String(exportError),
      }))
    }),
  )
}
