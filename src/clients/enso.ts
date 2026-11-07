import type { EnsoPriceResponse } from '../types'
import {
  type FetchJsonConfig,
  fetchJsonWithRetry,
  SharedCooldownRateLimiter,
  SlidingWindowRateLimiter
} from './http-client'
import { createProviderTransportFromEnv, type ProviderTransport } from './provider-transport'

const BASE_URL = 'https://api.enso.build'
const ENSO_ATTEMPT_TIMEOUT_MS = 4_000

// Module-level so the limit and provider cooldown are shared across per-request
// EnsoClient instances within an isolate.
const sharedRateLimiter = new SharedCooldownRateLimiter(10, 1000, ENSO_ATTEMPT_TIMEOUT_MS)

export interface EnsoRequestOptions {
  /** Runtime bindings used by the caller to construct a transport. */
  env?: Record<string, string | undefined>
  timeoutMs?: number
  honorRetryAfter?: boolean
  retryAfterCapMs?: number
  retryRateLimits?: boolean
  retryTransportErrors?: boolean
  retryInvalidJson?: boolean
  onRateLimit?: FetchJsonConfig['onRateLimit']
  onCooldown?: FetchJsonConfig['onCooldown']
  defaultCooldownMs?: number
  transport?: ProviderTransport
}

export class EnsoClient {
  constructor(
    private readonly apiKey: string,
    private readonly rateLimiter: SlidingWindowRateLimiter = sharedRateLimiter,
    private readonly onRetry?: (attempt: number, delayMs: number, url: string, status: number) => void,
    private readonly requestOptions: EnsoRequestOptions = {}
  ) {}

  getPrice(chainId: number, address: string, options: { signal?: AbortSignal } = {}): Promise<EnsoPriceResponse> {
    const url = `${BASE_URL}/api/v1/prices/${chainId}/${address}`
    return fetchJsonWithRetry<EnsoPriceResponse>(url, {
      service: 'Enso',
      rateLimiter: this.rateLimiter,
      headers: { authorization: `Bearer ${this.apiKey}` },
      notFoundAsError: true,
      onRetry: this.onRetry,
      ...this.requestOptions,
      // A live spot source should hand rate limits to its later source instead
      // of multiplying a provider burst with three synchronized retries.
      retryRateLimits: this.requestOptions.retryRateLimits ?? false,
      honorRetryAfter: this.requestOptions.honorRetryAfter ?? true,
      defaultCooldownMs: this.requestOptions.defaultCooldownMs ?? 60_000,
      transport: this.requestOptions.transport ?? createProviderTransportFromEnv(this.requestOptions.env),
      signal: options.signal,
      timeoutMs: this.requestOptions.timeoutMs ?? ENSO_ATTEMPT_TIMEOUT_MS
    })
  }
}
