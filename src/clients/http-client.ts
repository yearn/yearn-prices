import { ApiError, type ErrorCode } from '../http/errors'

const MAX_TIMER_DELAY_MS = 2_147_483_647

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }

  const waitMs = Math.max(0, milliseconds)
  if (waitMs === 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown) => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const onAbort = () => finish(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    const schedule = (remaining: number) => {
      timer = setTimeout(
        () => {
          if (remaining <= MAX_TIMER_DELAY_MS) {
            finish()
          } else {
            schedule(remaining - MAX_TIMER_DELAY_MS)
          }
        },
        Math.min(remaining, MAX_TIMER_DELAY_MS)
      )
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    schedule(waitMs)
  })
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = []

  constructor(
    private readonly limit: number,
    private readonly intervalMs: number
  ) {}

  async waitTurn(signal?: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal)
      const now = Date.now()
      while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.intervalMs) {
        this.timestamps.shift()
      }

      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now)
        return
      }

      const waitMs = this.intervalMs - (now - this.timestamps[0])
      await sleepWithSignal(Math.max(waitMs, 25), signal)
    }
  }
}

/** A sliding-window limiter with a provider-wide gate shared by all its callers. */
export class SharedCooldownRateLimiter extends SlidingWindowRateLimiter {
  private cooldownUntil = 0

  constructor(
    limit: number,
    intervalMs: number,
    private readonly maxCooldownWaitMs = Number.POSITIVE_INFINITY
  ) {
    super(limit, intervalMs)
  }

  extendCooldown(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs)
  }

  override async waitTurn(signal?: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal)
      const cooldownWait = this.cooldownUntil - Date.now()
      if (cooldownWait > this.maxCooldownWaitMs) {
        throw new ApiError(
          'UNAVAILABLE',
          `Provider cooldown of ${Math.ceil(cooldownWait / 1000)}s exceeds request budget`
        )
      }
      if (cooldownWait > 0) {
        await sleepWithSignal(cooldownWait, signal)
      }
      await super.waitTurn(signal)
      if (this.cooldownUntil <= Date.now()) return
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
  // Called for every 429 response, including a terminal response that will not be retried.
  onRateLimit?: (retryAfterMs: number | null, url: string, status: number) => void
  // When true, a 404 becomes a typed NOT_FOUND ApiError instead of a retryable/internal error.
  notFoundAsError?: boolean
  // Opt-in hardening. Every field below is off by default so existing callers keep identical behavior.
  timeoutMs?: number
  honorRetryAfter?: boolean
  retryAfterCapMs?: number
  // When false, surface the first 429 immediately instead of adding a synchronized retry burst.
  retryRateLimits?: boolean
  // Retry a request that never reached the server (socket/DNS failure or timeout abort).
  retryTransportErrors?: boolean
  // Retry a 2xx response whose body fails JSON parsing (e.g. a truncated payload).
  retryInvalidJson?: boolean
  // Cancels queueing, backoff, active fetch, and response-body reads.
  signal?: AbortSignal
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
  const timeoutSignal = config.timeoutMs === undefined ? undefined : AbortSignal.timeout(config.timeoutMs)
  const signal =
    timeoutSignal && config.signal ? AbortSignal.any([timeoutSignal, config.signal]) : (timeoutSignal ?? config.signal)
  if (signal === undefined && config.headers === undefined) return undefined
  return {
    ...(config.headers ? { headers: config.headers } : {}),
    ...(signal ? { signal } : {})
  }
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function isJsonParseError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'SyntaxError'
}

export async function fetchJsonWithRetry<T>(url: string, config: FetchJsonConfig): Promise<T> {
  const lastAttempt = RETRY_DELAYS.length - 1

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    throwIfAborted(config.signal)
    await config.rateLimiter.waitTurn(config.signal)

    const scheduleRetry = async (delayMs: number, status: number): Promise<void> => {
      config.onRetry?.(attempt + 1, delayMs, url, status)
      console.warn(`${config.service} request failed (${status}), retrying in ${delayMs}ms: ${url}`)
      await sleepWithSignal(delayMs, config.signal)
    }

    // Returns normally when the caller should retry; throws otherwise.
    const failOrRetryTransport = async (error: unknown): Promise<void> => {
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
    }

    let response: Response
    try {
      throwIfAborted(config.signal)
      response = await fetch(url, requestInit(config))
    } catch (error) {
      await failOrRetryTransport(error)
      continue
    }

    if (response.ok) {
      try {
        const value = (await response.json()) as T
        throwIfAborted(config.signal)
        return value
      } catch (error) {
        // A timeout or reset while the body streams rejects here, not at fetch.
        if (!isJsonParseError(error)) {
          await failOrRetryTransport(error)
          continue
        }

        if (!config.retryInvalidJson) {
          throw error
        }

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

    const retryAfter = config.honorRetryAfter
      ? parseRetryAfter(response.headers.get('retry-after'), config.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS)
      : null
    if (response.status === 429) {
      config.onRateLimit?.(retryAfter, url, response.status)
    }

    const shouldRetry = (response.status === 429 && config.retryRateLimits !== false) || response.status >= 500
    if (!shouldRetry || attempt === lastAttempt) {
      throw new HttpRequestError(
        'INTERNAL_ERROR',
        `${config.service} request failed with status ${response.status}`,
        'provider_response',
        attempt + 1,
        response.status
      )
    }

    await scheduleRetry(Math.max(retryAfter ?? 0, RETRY_DELAYS[attempt]), response.status)
  }

  throw new ApiError('INTERNAL_ERROR', `Unexpected ${config.service} retry state`)
}
