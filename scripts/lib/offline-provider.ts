import { CHART_RETRY_AFTER_CAP_MS } from '../../src/backfill/constants'
import { DefiLlamaClient } from '../../src/clients/defillama'
import { SharedCooldownRateLimiter } from '../../src/clients/http-client'
import { BatchedHistoricalClient } from './batched-historical-client'

export interface OfflineProviderOptions {
  timeoutMs?: number
  onRetry?: () => void
  allowIntraday?: boolean
  retryRateLimits?: boolean
  signal?: AbortSignal
}

export function createOfflineDefiLlamaClient(rps: number, options: OfflineProviderOptions = {}) {
  if (!Number.isInteger(rps) || rps < 1 || rps > 10) throw new Error('provider-rps must be 1 through 10')
  const rateLimiter = new SharedCooldownRateLimiter(rps, 1000)
  return new DefiLlamaClient(rateLimiter, () => options.onRetry?.(), {
    timeoutMs: options.timeoutMs ?? 10000,
    honorRetryAfter: true,
    retryRateLimits: options.retryRateLimits ?? true,
    retryAfterCapMs: CHART_RETRY_AFTER_CAP_MS,
    signal: options.signal,
    onRateLimit: (retryAfterMs) => rateLimiter.extendCooldown(retryAfterMs ?? 60_000)
  })
}

export function offlineProvider(rps: number, options: OfflineProviderOptions = {}) {
  return new BatchedHistoricalClient(createOfflineDefiLlamaClient(rps, options), {
    allowIntraday: options.allowIntraday
  })
}
