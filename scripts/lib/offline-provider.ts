import { CHART_RETRY_AFTER_CAP_MS } from '../../src/backfill/constants'
import { DefiLlamaClient } from '../../src/clients/defillama'
import { SharedCooldownRateLimiter } from '../../src/clients/http-client'
import type { ProviderTransport } from '../../src/clients/provider-transport'
import { BatchedHistoricalClient } from './batched-historical-client'

export interface OfflineProviderOptions {
  timeoutMs?: number
  onRetry?: () => void
  allowIntraday?: boolean
  retryRateLimits?: boolean
  signal?: AbortSignal
  transport?: ProviderTransport
}

export function createOfflineDefiLlamaClient(rps: number, options: OfflineProviderOptions = {}) {
  if (!Number.isInteger(rps) || rps < 1 || rps > 10) throw new Error('provider-rps must be 1 through 10')
  // Keep the full provider cooldown, but don't hold a job open beyond the
  // existing ten-minute retry budget when a provider returns a very distant date.
  const rateLimiter = new SharedCooldownRateLimiter(rps, 1000, CHART_RETRY_AFTER_CAP_MS)
  return new DefiLlamaClient(rateLimiter, () => options.onRetry?.(), {
    timeoutMs: options.timeoutMs ?? 10000,
    honorRetryAfter: true,
    retryRateLimits: options.retryRateLimits ?? true,
    retryAfterCapMs: CHART_RETRY_AFTER_CAP_MS,
    signal: options.signal,
    transport: options.transport,
    onRateLimit: (retryAfterMs) => rateLimiter.extendCooldown(retryAfterMs ?? 60_000),
    onCooldown: (retryAfterMs) => rateLimiter.extendCooldown(retryAfterMs ?? 60_000)
  })
}

export function offlineProvider(rps: number, options: OfflineProviderOptions = {}) {
  return new BatchedHistoricalClient(createOfflineDefiLlamaClient(rps, options), {
    allowIntraday: options.allowIntraday
  })
}
