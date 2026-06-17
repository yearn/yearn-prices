import { fetchJsonWithRetry, SlidingWindowRateLimiter } from './http-client'
import type { DefiLlamaBatchResponse, DefiLlamaHistoricalResponse } from './types'

const BASE_URL = 'https://coins.llama.fi'

export class DefiLlamaClient {
  constructor(
    private readonly rateLimiter = new SlidingWindowRateLimiter(10, 1000),
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void,
  ) {}

  getHistorical(timestamp: number, coins: string[], searchWidth = '6h'): Promise<DefiLlamaHistoricalResponse> {
    const joinedCoins = coins.join(',')
    const url = `${BASE_URL}/prices/historical/${timestamp}/${joinedCoins}?searchWidth=${encodeURIComponent(searchWidth)}`
    return this.fetchJson<DefiLlamaHistoricalResponse>(url)
  }

  getBatchHistorical(coins: Record<string, number[]>, searchWidth = '6h'): Promise<DefiLlamaBatchResponse> {
    const url = new URL(`${BASE_URL}/batchHistorical`)
    url.searchParams.set('coins', JSON.stringify(coins))
    url.searchParams.set('searchWidth', searchWidth)
    return this.fetchJson<DefiLlamaBatchResponse>(url.toString())
  }

  private fetchJson<T>(url: string): Promise<T> {
    return fetchJsonWithRetry<T>(url, {
      service: 'DeFiLlama',
      rateLimiter: this.rateLimiter,
      onRetry: this.onRetry,
    })
  }
}
