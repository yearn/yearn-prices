import { DEFI_LLAMA_SEARCH_WIDTH, DefiLlamaClient } from '../../src/clients/defillama'
import { ApiError } from '../../src/http/errors'
import { buildDefiLlamaPayloads } from '../../src/sources/defillama/batch'
import { matchPricesToRequests } from '../../src/sources/defillama/match'
import type { DefiLlamaHistoricalCoin, DefiLlamaHistoricalResponse } from '../../src/types'

export interface CoinTarget {
  coin: string
  timestamp: number
}

interface Pending extends CoinTarget {
  resolve: (coin: DefiLlamaHistoricalCoin | null) => void
  reject: (error: unknown) => void
}

/** Offline EOD transport: the existing sources consume its single-lookup shape,
 * but every HTTP call uses batchHistorical. Caches belong to this run only. */
export class BatchedHistoricalClient extends DefiLlamaClient {
  readonly stats = { lookups: 0, uniqueLookups: 0, cacheHits: 0, batchRequests: 0, failedBatches: 0 }
  private readonly cache = new Map<string, Promise<DefiLlamaHistoricalCoin | null>>()
  private readonly pending = new Map<string, Pending>()
  private scheduled = false
  private draining = false
  private discovery: Map<string, CoinTarget> | null = null

  constructor(private readonly transport: Pick<DefiLlamaClient, 'getBatchHistorical'>) {
    super()
  }

  /** Probe existing adapters without fetching unknown market observations.
   * Probe results are provisional and must never be emitted as final prices or
   * confirmed misses. Unknowns are collected, not inserted into the cache. */
  async discover(work: () => Promise<void>): Promise<CoinTarget[]> {
    if (this.discovery || this.draining || this.pending.size > 0) {
      throw new Error('Discovery requires an idle historical client')
    }
    const targets = new Map<string, CoinTarget>()
    this.discovery = targets
    try {
      await work()
      return [...targets.values()]
    } finally {
      this.discovery = null
    }
  }

  async prefetch(targets: CoinTarget[]): Promise<void> {
    // Failed lookups stay rejected in this run's cache. Consumers receive the
    // same retryable error rather than triggering a single-request retry storm.
    await Promise.allSettled(targets.map((target) => this.lookup(target)))
  }

  override async getHistorical(
    timestamp: number,
    coins: string[],
    searchWidth = DEFI_LLAMA_SEARCH_WIDTH
  ): Promise<DefiLlamaHistoricalResponse> {
    if (searchWidth !== DEFI_LLAMA_SEARCH_WIDTH) throw new Error('Offline batching requires the standard 12h window')
    const results = await Promise.all(
      coins.map(async (coin) => ({ coin, value: await this.lookup({ coin, timestamp }) }))
    )
    return {
      coins: Object.fromEntries(results.filter((r) => r.value !== null).map((r) => [r.coin, r.value!]))
    }
  }

  private lookup(target: CoinTarget): Promise<DefiLlamaHistoricalCoin | null> {
    if (
      !Number.isSafeInteger(target.timestamp) ||
      target.timestamp <= 0 ||
      target.timestamp % 86400 !== 86399 ||
      target.timestamp >= Date.now() / 1000
    ) {
      return Promise.reject(new Error('Offline batching requires a closed UTC EOD timestamp'))
    }
    const normalized = { ...target, coin: target.coin.toLowerCase() }
    const key = `${normalized.coin}:${target.timestamp}`
    if (this.discovery) {
      const cached = this.cache.get(key)
      if (cached) return cached
      this.discovery.set(key, normalized)
      return Promise.resolve(null)
    }
    this.stats.lookups += 1
    const cached = this.cache.get(key)
    if (cached) {
      this.stats.cacheHits += 1
      return cached
    }
    this.stats.uniqueLookups += 1
    const promise = new Promise<DefiLlamaHistoricalCoin | null>((resolve, reject) => {
      this.pending.set(key, { ...normalized, resolve, reject })
    })
    this.cache.set(key, promise)
    this.schedule()
    return promise
  }

  private schedule(): void {
    if (this.scheduled || this.draining) return
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      void this.drain()
    }, 10)
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.pending.size > 0) {
        const work = new Map(this.pending)
        this.pending.clear()
        const grouped: Record<string, number[]> = {}
        for (const target of work.values()) {
          grouped[target.coin] ??= []
          grouped[target.coin].push(target.timestamp)
        }
        // Sequential batches share the transport's pacing and Retry-After gate.
        for (const payload of buildDefiLlamaPayloads(grouped)) {
          const members = Object.entries(payload).flatMap(([coin, times]) =>
            times.map((timestamp) => work.get(`${coin}:${timestamp}`)!)
          )
          try {
            this.stats.batchRequests += 1
            const response = await this.transport.getBatchHistorical(payload)
            if (!response?.coins || typeof response.coins !== 'object' || Array.isArray(response.coins)) {
              throw new ApiError('UNAVAILABLE', 'Malformed DeFiLlama batch envelope')
            }
            const resolved = new Map<string, DefiLlamaHistoricalCoin | null>()
            for (const [coin, timestamps] of Object.entries(payload)) {
              const entry = response.coins[coin]
              if (
                entry !== undefined &&
                (!Array.isArray(entry?.prices) ||
                  entry.prices.some(
                    (sample) =>
                      !sample ||
                      !Number.isSafeInteger(sample.timestamp) ||
                      sample.timestamp <= 0 ||
                      !Number.isFinite(sample.price) ||
                      sample.price <= 0
                  ))
              ) {
                throw new ApiError('UNAVAILABLE', 'Malformed DeFiLlama batch observations')
              }
              const observations = new Map<number, number>()
              for (const sample of entry?.prices ?? []) {
                const previous = observations.get(sample.timestamp)
                if (previous !== undefined && previous !== sample.price)
                  throw new ApiError('UNAVAILABLE', 'Conflicting DeFiLlama batch observations')
                observations.set(sample.timestamp, sample.price)
              }
              const matched = matchPricesToRequests(timestamps, entry?.prices ?? [])
              for (const timestamp of timestamps) {
                const sample = matched.get(timestamp)
                resolved.set(`${coin}:${timestamp}`, sample ? { ...sample, symbol: entry.symbol } : null)
              }
            }
            for (const member of members) member.resolve(resolved.get(`${member.coin}:${member.timestamp}`) ?? null)
          } catch (error) {
            this.stats.failedBatches += 1
            for (const member of members) member.reject(error)
          }
        }
      }
    } finally {
      this.draining = false
      if (this.pending.size > 0) this.schedule()
    }
  }
}
