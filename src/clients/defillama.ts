import type { DefiLlamaBatchResponse, DefiLlamaHistoricalResponse } from '../types'
import { fetchJsonWithRetry, SlidingWindowRateLimiter } from './http-client'

const BASE_URL = 'https://coins.llama.fi'

/** Widest window DeFiLlama may search for a sample around a requested timestamp. */
export const DEFI_LLAMA_SEARCH_WIDTH_SECONDS = 6 * 60 * 60
export const DEFI_LLAMA_SEARCH_WIDTH = `${DEFI_LLAMA_SEARCH_WIDTH_SECONDS / 3_600}h`

export class DefiLlamaClient {
  constructor(
    private readonly rateLimiter = new SlidingWindowRateLimiter(10, 1000),
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void
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

  private fetchJson<T>(url: string): Promise<T> {
    return fetchJsonWithRetry<T>(url, {
      service: 'DeFiLlama',
      rateLimiter: this.rateLimiter,
      onRetry: this.onRetry
    })
  }
}
