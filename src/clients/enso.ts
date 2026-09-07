import type { EnsoPriceResponse } from '../types'
import { fetchJsonWithRetry, SlidingWindowRateLimiter } from './http-client'

const BASE_URL = 'https://api.enso.build'

// Module-level so the limit is shared across per-request EnsoClient instances within an isolate.
const sharedRateLimiter = new SlidingWindowRateLimiter(10, 1000)

// Spot is request-path work behind an overall deadline; a stalled socket must not
// hold the batch open until the platform kills the worker.
const REQUEST_TIMEOUT_MS = 5_000

export class EnsoClient {
  constructor(
    private readonly apiKey: string,
    private readonly rateLimiter: SlidingWindowRateLimiter = sharedRateLimiter,
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void
  ) {}

  getPrice(chainId: number, address: string): Promise<EnsoPriceResponse> {
    const url = `${BASE_URL}/api/v1/prices/${chainId}/${address}`
    return fetchJsonWithRetry<EnsoPriceResponse>(url, {
      service: 'Enso',
      rateLimiter: this.rateLimiter,
      headers: { authorization: `Bearer ${this.apiKey}` },
      notFoundAsError: true,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryTransportErrors: true,
      onRetry: this.onRetry
    })
  }
}
