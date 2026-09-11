import { DefiLlamaClient } from '../../src/clients/defillama'
import { SlidingWindowRateLimiter } from '../../src/clients/http-client'
import { BatchedHistoricalClient } from './batched-historical-client'
export function createOfflineDefiLlamaClient(rps: number, options: { timeoutMs?: number; onRetry?: () => void } = {}) {
  if (!Number.isInteger(rps) || rps < 1 || rps > 10) throw new Error('provider-rps must be 1 through 10')
  let cooldown = 0
  class Limiter extends SlidingWindowRateLimiter {
    override async waitTurn() {
      while (Date.now() < cooldown)
        await new Promise((done) => setTimeout(done, Math.min(60000, cooldown - Date.now())))
      await super.waitTurn()
      if (Date.now() < cooldown) await this.waitTurn()
    }
  }
  return new DefiLlamaClient(
    new Limiter(rps, 1000),
    (_attempt, delay, _url, status) => {
      if (status === 429) cooldown = Math.max(cooldown, Date.now() + Math.max(delay, 60000))
      options.onRetry?.()
    },
    { timeoutMs: options.timeoutMs ?? 10000, honorRetryAfter: true, retryRateLimits: true, retryAfterCapMs: 43200000 }
  )
}

export function offlineProvider(rps: number, options: { timeoutMs?: number; onRetry?: () => void } = {}) {
  return new BatchedHistoricalClient(createOfflineDefiLlamaClient(rps, options))
}
