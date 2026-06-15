import { SlidingWindowRateLimiter } from './defillama'
import { ApiError } from './errors'
import type { EnsoPriceResponse } from './types'

const BASE_URL = 'https://api.enso.build'

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

// Module-level so the limit is shared across per-request EnsoClient instances within an isolate.
const sharedRateLimiter = new SlidingWindowRateLimiter(10, 1000)

export class EnsoClient {
  constructor(
    private readonly apiKey: string,
    private readonly rateLimiter: SlidingWindowRateLimiter = sharedRateLimiter,
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void,
  ) {}

  async getPrice(chainId: number, address: string): Promise<EnsoPriceResponse> {
    const url = `${BASE_URL}/api/v1/prices/${chainId}/${address}`
    return this.fetchJson<EnsoPriceResponse>(url)
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const delays = [1000, 2000, 4000]
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await this.rateLimiter.waitTurn()
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      })
      if (response.ok) {
        return await response.json() as T
      }

      if (response.status === 404) {
        throw new ApiError('NOT_FOUND', `Enso has no price for ${url}`)
      }

      const shouldRetry = response.status === 429 || response.status >= 500
      if (!shouldRetry || attempt === delays.length - 1) {
        throw new ApiError('INTERNAL_ERROR', `Enso request failed with status ${response.status}`)
      }

      const delay = delays[attempt]
      this.onRetry?.(attempt + 1, delay, url, response.status)
      console.warn(`Enso request failed (${response.status}), retrying in ${delay}ms: ${url}`)
      await sleep(delay)
    }

    throw new ApiError('INTERNAL_ERROR', 'Unexpected Enso retry state')
  }
}
