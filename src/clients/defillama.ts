import { ApiError } from '../http/errors'
import type { DefiLlamaBatchResponse, DefiLlamaChartResponse, DefiLlamaHistoricalResponse } from '../types'
import { fetchJsonWithRetry, SlidingWindowRateLimiter } from './http-client'

const BASE_URL = 'https://coins.llama.fi'

export interface DefiLlamaChartOptions {
  start?: number
  end?: number
  span?: number
  period: string
  searchWidth?: string
}

export interface DefiLlamaRequestOptions {
  timeoutMs?: number
  honorRetryAfter?: boolean
  retryAfterCapMs?: number
  retryTransportErrors?: boolean
  retryInvalidJson?: boolean
}

/** Widest window DeFiLlama may search for a sample around a requested timestamp. */
export const DEFI_LLAMA_SEARCH_WIDTH_SECONDS = 6 * 60 * 60
export const DEFI_LLAMA_SEARCH_WIDTH = `${DEFI_LLAMA_SEARCH_WIDTH_SECONDS / 3_600}h`

export class DefiLlamaClient {
  constructor(
    private readonly rateLimiter = new SlidingWindowRateLimiter(10, 1000),
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
    return this.fetchJson<DefiLlamaHistoricalResponse>(url)
  }

  getBatchHistorical(
    coins: Record<string, number[]>,
    searchWidth = DEFI_LLAMA_SEARCH_WIDTH
  ): Promise<DefiLlamaBatchResponse> {
    const url = new URL(`${BASE_URL}/batchHistorical`)
    url.searchParams.set('coins', JSON.stringify(coins))
    url.searchParams.set('searchWidth', searchWidth)
    return this.fetchJson<DefiLlamaBatchResponse>(url.toString())
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
    url.searchParams.set('searchWidth', options.searchWidth ?? '6h')
    return this.fetchJson<DefiLlamaChartResponse>(url.toString())
  }

  private fetchJson<T>(url: string): Promise<T> {
    return fetchJsonWithRetry<T>(url, {
      service: 'DeFiLlama',
      rateLimiter: this.rateLimiter,
      onRetry: this.onRetry,
      ...this.requestOptions
    })
  }
}
