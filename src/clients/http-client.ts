import { ApiError, type ErrorCode } from '../http/errors'
import type { ProviderTransport } from './provider-transport'

// Operational ceiling: retry implausibly long provider lockouts after one hour.
export const MAX_PROVIDER_COOLDOWN_MS = 60 * 60 * 1000

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
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(delayMs, MAX_PROVIDER_COOLDOWN_MS))
  }

  /** Whether waiting for the provider gate still fits this limiter's budget. */
  cooldownWithinBudget(): boolean {
    return this.cooldownUntil - Date.now() <= this.maxCooldownWaitMs
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
  // Called for provider responses that ask all callers to cool down. Unlike
  // onRateLimit, this also includes 5xx gateway/provider responses and receives the uncapped
  // Retry-After delay so a shared gate can preserve the provider's full wait.
  onCooldown?: (retryAfterMs: number | null, url: string, status: number) => void
  // Default shared cooldown when a rate-limit response omits Retry-After.
  // Live provider clients set this to a conservative minute; generic callers
  // leave it unset to preserve the historical retry behavior.
  defaultCooldownMs?: number
  // Optional runtime-specific transport (for example a Bun proxy or an
  // authenticated relay in a Worker). It must preserve the upstream response.
  transport?: ProviderTransport
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

/** A finite upper bound used only to avoid numeric overflow while retaining
 * provider-supplied waits up to the one-hour operational ceiling. Per-attempt retry delays still use retryAfterCapMs.
 */
const MAX_RETRY_AFTER_MS = MAX_PROVIDER_COOLDOWN_MS

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

function sanitizeMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s)]+/gi, '[provider-url]')
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * A caller cancellation must not poison the route that another request may be
 * using. A timeout/deadline cancellation is different: it means the provider
 * route failed to deliver the body within its budget and should be reported
 * to the transport for quarantine. AbortSignal.timeout() exposes that
 * distinction through its TimeoutError reason.
 */
function isCallerCancellation(signal: AbortSignal | undefined, error: unknown): boolean {
  if (!signal?.aborted) return false
  const reasonName = (signal.reason as { name?: string } | null | undefined)?.name
  if (reasonName === 'TimeoutError') return false
  if (reasonName === 'AbortError') return true
  // An explicit non-timeout reason (including a caller's Error) is a caller
  // cancellation. If a runtime supplies no reason, preserve the historical
  // AbortError distinction and treat only non-timeout errors as cancellation.
  if (signal.reason !== undefined) return true
  return (error as { name?: string } | null)?.name !== 'TimeoutError'
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
      // Do not put token/query strings (or relay credentials) into Worker logs.
      console.warn(`${config.service} request failed (${status}), retrying in ${delayMs}ms`)
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
          `${config.service} request failed: ${sanitizeMessage((error as Error).message)}`,
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
      response = config.transport
        ? await config.transport.fetch(url, requestInit(config))
        : await fetch(url, requestInit(config))
    } catch (error) {
      // The transport knows which proxy was selected and quarantines that
      // route itself; reporting here would lose the route identity.
      await failOrRetryTransport(error)
      continue
    }

    if (response.ok) {
      try {
        const value = (await response.json()) as T
        throwIfAborted(config.signal)
        config.transport?.report(response, 'success')
        return value
      } catch (error) {
        if (!isCallerCancellation(config.signal, error)) config.transport?.report(response, 'failure')
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

    // Error payloads are not used. Release their streams before another
    // attempt so repeated failures do not occupy connections indefinitely.
    void response.body?.cancel().catch(() => {})
    if (config.notFoundAsError && response.status === 404) {
      throw new ApiError('NOT_FOUND', `${config.service} has no price for the requested target`)
    }

    const retryAfterHeader = response.headers?.get('retry-after') ?? null
    const retryAfter = config.honorRetryAfter
      ? parseRetryAfter(retryAfterHeader, config.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS)
      : null
    const cooldown = config.honorRetryAfter ? parseRetryAfter(retryAfterHeader, MAX_RETRY_AFTER_MS) : null
    if (response.status === 429) {
      config.onRateLimit?.(retryAfter, url, response.status)
    }
    if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
      // A shared limiter is the provider-wide gate even when a caller did not
      // install an explicit callback. This intentionally uses the uncapped
      // delay (up to the one-hour ceiling); retryAfterCapMs only bounds one retry sleep.
      const sharedCooldown = cooldown ?? (response.status === 429 ? (config.defaultCooldownMs ?? null) : null)
      if (sharedCooldown !== null && config.rateLimiter instanceof SharedCooldownRateLimiter) {
        config.rateLimiter.extendCooldown(sharedCooldown)
      }
      config.onCooldown?.(cooldown, url, response.status)
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

    if (config.rateLimiter instanceof SharedCooldownRateLimiter && !config.rateLimiter.cooldownWithinBudget()) {
      throw new ApiError('UNAVAILABLE', `${config.service} provider cooldown exceeds request budget`)
    }
    await scheduleRetry(Math.max(retryAfter ?? 0, RETRY_DELAYS[attempt]), response.status)
  }

  throw new ApiError('INTERNAL_ERROR', `Unexpected ${config.service} retry state`)
}
