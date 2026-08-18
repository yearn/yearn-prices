import { ApiError } from '../http/errors'

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = []

  constructor(
    private readonly limit: number,
    private readonly intervalMs: number,
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

export interface FetchJsonConfig {
  // Used in error messages and retry logs.
  service: string
  rateLimiter: SlidingWindowRateLimiter
  headers?: Record<string, string>
  onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void
  // When true, a 404 becomes a typed NOT_FOUND ApiError instead of a retryable/internal error.
  notFoundAsError?: boolean
}

const RETRY_DELAYS = [1000, 2000, 4000]

export async function fetchJsonWithRetry<T>(url: string, config: FetchJsonConfig): Promise<T> {
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    await config.rateLimiter.waitTurn()
    const response = await fetch(url, config.headers ? { headers: config.headers } : undefined)
    if (response.ok) {
      return (await response.json()) as T
    }

    if (config.notFoundAsError && response.status === 404) {
      throw new ApiError('NOT_FOUND', `${config.service} has no price for ${url}`)
    }

    const shouldRetry = response.status === 429 || response.status >= 500
    if (!shouldRetry || attempt === RETRY_DELAYS.length - 1) {
      throw new ApiError('INTERNAL_ERROR', `${config.service} request failed with status ${response.status}`)
    }

    const delay = RETRY_DELAYS[attempt]
    config.onRetry?.(attempt + 1, delay, url, response.status)
    console.warn(`${config.service} request failed (${response.status}), retrying in ${delay}ms: ${url}`)
    await sleep(delay)
  }

  throw new ApiError('INTERNAL_ERROR', `Unexpected ${config.service} retry state`)
}
