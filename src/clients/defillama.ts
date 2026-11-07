import { ApiError } from '../http/errors'
import type { DefiLlamaBatchResponse, DefiLlamaChartResponse, DefiLlamaHistoricalResponse } from '../types'
import { fetchJsonWithRetry, SharedCooldownRateLimiter, type SlidingWindowRateLimiter } from './http-client'
import { createProviderTransportFromEnv, type ProviderTransport } from './provider-transport'

const BASE_URL = 'https://coins.llama.fi'

export interface DefiLlamaChartOptions {
  start?: number
  end?: number
  span?: number
  period: string
  searchWidth?: string
}

export interface DefiLlamaRequestOptions {
  /** Runtime bindings used by the caller to construct a transport. Kept here
   * for source factories that pass their Worker environment through. */
  env?: Record<string, string | undefined>
  timeoutMs?: number
  honorRetryAfter?: boolean
  retryAfterCapMs?: number
  retryRateLimits?: boolean
  retryTransportErrors?: boolean
  retryInvalidJson?: boolean
  onRateLimit?: (retryAfterMs: number | null, url: string, status: number) => void
  onCooldown?: (retryAfterMs: number | null, url: string, status: number) => void
  defaultCooldownMs?: number
  transport?: ProviderTransport
  signal?: AbortSignal
}

/** Widest window DeFiLlama may search for a sample around a requested timestamp. */
export const DEFI_LLAMA_SEARCH_WIDTH_SECONDS = 6 * 60 * 60
export const DEFI_LLAMA_SEARCH_WIDTH = `${DEFI_LLAMA_SEARCH_WIDTH_SECONDS / 3_600}h`

// Requests created without an injected limiter still share a provider-wide
// gate. A long Retry-After is retained in the gate, while live callers can
// fail fast when the cooldown exceeds their route budget.
const sharedRateLimiter = new SharedCooldownRateLimiter(10, 1000, 2_500)

export class DefiLlamaClient {
  constructor(
    private readonly rateLimiter: SlidingWindowRateLimiter = sharedRateLimiter,
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void,
    private readonly requestOptions: DefiLlamaRequestOptions = {}
  ) {}

  getHistorical(
    timestamp: number,
    coins: string[],
    searchWidth = DEFI_LLAMA_SEARCH_WIDTH
  ): Promise<DefiLlamaHistoricalResponse> {
    const joinedCoins = coins.join(',')
    const url = `${BASE_URL}/prices/historical/${timestamp}/${joinedCoins}?searchWidth=${encodeURIComponent(searchWidth)}`
    return this.fetchCoins<DefiLlamaHistoricalResponse>(url)
  }

  getBatchHistorical(
    coins: Record<string, number[]>,
    searchWidth = DEFI_LLAMA_SEARCH_WIDTH
  ): Promise<DefiLlamaBatchResponse> {
    const url = new URL(`${BASE_URL}/batchHistorical`)
    url.searchParams.set('coins', JSON.stringify(coins))
    url.searchParams.set('searchWidth', searchWidth)
    return this.fetchCoins<DefiLlamaBatchResponse>(url.toString())
  }

  getCurrent(coins: string[], signal?: AbortSignal): Promise<DefiLlamaHistoricalResponse> {
    return this.fetchCoins<DefiLlamaHistoricalResponse>(`${BASE_URL}/prices/current/${coins.join(',')}`, signal)
  }

  getFirst(coins: string[]): Promise<DefiLlamaHistoricalResponse> {
    return this.fetchCoins<DefiLlamaHistoricalResponse>(`${BASE_URL}/prices/first/${coins.join(',')}`)
  }

  getChart(coins: string[], options: DefiLlamaChartOptions): Promise<DefiLlamaChartResponse> {
    if ((options.start === undefined) === (options.end === undefined)) {
      throw new ApiError('INVALID_INPUT', 'DeFiLlama /chart requires either start or end, not both')
    }

    const url = new URL(
      `${BASE_URL}/chart/${coins.map((coin) => encodeURIComponent(coin).replaceAll('%3A', ':')).join(',')}`
    )
    if (options.start !== undefined) {
      url.searchParams.set('start', String(options.start))
    }
    if (options.end !== undefined) {
      url.searchParams.set('end', String(options.end))
    }
    if (options.span !== undefined) {
      url.searchParams.set('span', String(options.span))
    }
    url.searchParams.set('period', options.period)
    url.searchParams.set('searchWidth', options.searchWidth ?? DEFI_LLAMA_SEARCH_WIDTH)
    return this.fetchJson<DefiLlamaChartResponse>(url.toString())
  }

  private async fetchCoins<T extends { coins: unknown }>(url: string, signal?: AbortSignal): Promise<T> {
    const body = await this.fetchJson<T | null>(url, signal)
    const coins = body?.coins
    if (typeof coins !== 'object' || coins === null || Array.isArray(coins)) {
      throw new ApiError('UNAVAILABLE', 'Malformed DeFiLlama response envelope')
    }
    return body as T
  }

  private fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    return fetchJsonWithRetry<T>(url, {
      service: 'DeFiLlama',
      rateLimiter: this.rateLimiter,
      onRetry: this.onRetry,
      ...this.requestOptions,
      timeoutMs: this.requestOptions.timeoutMs ?? 2_500,
      retryRateLimits: this.requestOptions.retryRateLimits ?? this.rateLimiter !== sharedRateLimiter,
      honorRetryAfter: this.requestOptions.honorRetryAfter ?? true,
      defaultCooldownMs: this.requestOptions.defaultCooldownMs ?? 60_000,
      transport: this.requestOptions.transport ?? createProviderTransportFromEnv(this.requestOptions.env),
      ...(signal ? { signal } : {})
    })
  }
}
