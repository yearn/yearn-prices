import { ApiError } from './errors'
import type { DefiLlamaBatchResponse, DefiLlamaHistoricalResponse } from './types'

const BASE_URL = 'https://api.llama.fi'

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
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

export class DefiLlamaClient {
  constructor(
    private readonly rateLimiter = new SlidingWindowRateLimiter(10, 1000),
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void,
  ) {}

  async getHistorical(timestamp: number, coins: string[], searchWidth = '6h'): Promise<DefiLlamaHistoricalResponse> {
    const joinedCoins = coins.join(',')
    const url = `${BASE_URL}/prices/historical/${timestamp}/${joinedCoins}?searchWidth=${encodeURIComponent(searchWidth)}`
    return this.fetchJson<DefiLlamaHistoricalResponse>(url)
  }

  async getBatchHistorical(coins: Record<string, number[]>, searchWidth = '6h'): Promise<DefiLlamaBatchResponse> {
    const url = new URL(`${BASE_URL}/batchHistorical`)
    url.searchParams.set('coins', JSON.stringify(coins))
    url.searchParams.set('searchWidth', searchWidth)
    return this.fetchJson<DefiLlamaBatchResponse>(url.toString())
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const delays = [1000, 2000, 4000]
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await this.rateLimiter.waitTurn()
      const response = await fetch(url)
      if (response.ok) {
        return await response.json() as T
      }

      const shouldRetry = response.status === 429 || response.status >= 500
      if (!shouldRetry || attempt === delays.length - 1) {
        throw new ApiError('INTERNAL_ERROR', `DeFiLlama request failed with status ${response.status}`)
      }

      const delay = delays[attempt]
      this.onRetry?.(attempt + 1, delay, url, response.status)
      console.warn(`DeFiLlama request failed (${response.status}), retrying in ${delay}ms: ${url}`)
      await sleep(delay)
    }

    throw new ApiError('INTERNAL_ERROR', 'Unexpected DeFiLlama retry state')
  }
}
