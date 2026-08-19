import { ApiError, type ErrorCode } from '../http/errors'

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = []

  constructor(
    private readonly limit: number,
    private readonly intervalMs: number
  ) {}

  async waitTurn(): Promise<void> {
    while (true) {
      const now = Date.now()
      while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.intervalMs) {
        this.timestamps.shift()
      }

      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now)
        return
      }

      const waitMs = this.intervalMs - (now - this.timestamps[0])
      await sleep(Math.max(waitMs, 25))
    }
  }
}

export type HttpDiagnosticCode = 'timeout' | 'provider_response' | 'invalid_json' | 'transport'

export class HttpRequestError extends ApiError {
  readonly diagnosticCode: HttpDiagnosticCode
  readonly attempts: number
  readonly responseStatus: number | null

  constructor(
    code: ErrorCode,
    message: string,
    diagnosticCode: HttpDiagnosticCode,
    attempts: number,
    responseStatus: number | null
  ) {
    super(code, message)
    this.diagnosticCode = diagnosticCode
    this.attempts = attempts
    this.responseStatus = responseStatus
  }
}

export interface FetchJsonConfig {
  // Used in error messages and retry logs.
  service: string
  rateLimiter: SlidingWindowRateLimiter
  headers?: Record<string, string>
  onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void
  // When true, a 404 becomes a typed NOT_FOUND ApiError instead of a retryable/internal error.
  notFoundAsError?: boolean
  // Opt-in hardening. Every field below is off by default so existing callers keep identical behavior.
  timeoutMs?: number
  honorRetryAfter?: boolean
  retryAfterCapMs?: number
  retryTransportErrors?: boolean
}

const RETRY_DELAYS = [1000, 2000, 4000]

export const DEFAULT_RETRY_AFTER_CAP_MS = 60_000

export function parseRetryAfter(value: string | null, capMs: number, now = Date.now()): number | null {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, capMs)
  }

  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    return null
  }

  return Math.min(Math.max(parsed - now, 0), capMs)
}

function requestInit(config: FetchJsonConfig): RequestInit | undefined {
  if (config.timeoutMs === undefined) {
    return config.headers ? { headers: config.headers } : undefined
  }

  const signal = AbortSignal.timeout(config.timeoutMs)
  return config.headers ? { headers: config.headers, signal } : { signal }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

export async function fetchJsonWithRetry<T>(url: string, config: FetchJsonConfig): Promise<T> {
  const lastAttempt = RETRY_DELAYS.length - 1

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    await config.rateLimiter.waitTurn()

    const scheduleRetry = async (delayMs: number, status: number): Promise<void> => {
      config.onRetry?.(attempt + 1, delayMs, url, status)
      console.warn(`${config.service} request failed (${status}), retrying in ${delayMs}ms: ${url}`)
      await sleep(delayMs)
    }

    let response: Response
    try {
      response = await fetch(url, requestInit(config))
    } catch (error) {
      if (!config.retryTransportErrors) {
        throw error
      }

      const diagnosticCode: HttpDiagnosticCode = isAbortError(error) ? 'timeout' : 'transport'
      if (attempt === lastAttempt) {
        throw new HttpRequestError(
          'INTERNAL_ERROR',
          `${config.service} request failed: ${(error as Error).message}`,
          diagnosticCode,
          attempt + 1,
          null
        )
      }

      await scheduleRetry(RETRY_DELAYS[attempt], 0)
      continue
    }

    if (response.ok) {
      if (!config.retryTransportErrors) {
        return (await response.json()) as T
      }

      try {
        return (await response.json()) as T
      } catch (error) {
        if (attempt === lastAttempt) {
          throw new HttpRequestError(
            'INTERNAL_ERROR',
            `${config.service} returned invalid JSON: ${(error as Error).message}`,
            'invalid_json',
            attempt + 1,
            response.status
          )
        }

        await scheduleRetry(RETRY_DELAYS[attempt], response.status)
        continue
      }
    }

    if (config.notFoundAsError && response.status === 404) {
      throw new ApiError('NOT_FOUND', `${config.service} has no price for ${url}`)
    }

    const shouldRetry = response.status === 429 || response.status >= 500
    if (!shouldRetry || attempt === lastAttempt) {
      throw new HttpRequestError(
        'INTERNAL_ERROR',
        `${config.service} request failed with status ${response.status}`,
        'provider_response',
        attempt + 1,
        response.status
      )
    }

    const retryAfter = config.honorRetryAfter
      ? parseRetryAfter(response.headers.get('retry-after'), config.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS)
      : null

    await scheduleRetry(retryAfter ?? RETRY_DELAYS[attempt], response.status)
  }

  throw new ApiError('INTERNAL_ERROR', `Unexpected ${config.service} retry state`)
}
