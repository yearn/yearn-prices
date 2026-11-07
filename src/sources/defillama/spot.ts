import { DefiLlamaClient } from '../../clients/defillama'
import { ApiError } from '../../http/errors'
import { isRejectedPrice } from '../../prices/rejections'
import type { Env } from '../../types'
import { chainIdToName } from '../../utils/chains'
import { currentUtcDayEnd, nowUnix } from '../../utils/time'
import { SpotPriceSourceBase } from '../base'
import type { SpotPriceResult } from '../types'
import { toHistoricalPrice } from './coin'
import { CURRENT_MAX_AGE_SECONDS, CURRENT_MAX_FUTURE_SKEW_SECONDS, DEFI_LLAMA_CURRENT_BATCH } from './current'
import { DEFILLAMA_UNSUPPORTED_CHAINS } from './historical'

/** Maximum number of coins sent to one /prices/current request. */
export const DEFI_LLAMA_SPOT_BATCH = DEFI_LLAMA_CURRENT_BATCH
/** Keep a provider request from consuming the complete spot route deadline. */
export const DEFI_LLAMA_SPOT_TIMEOUT_MS = 2_500
/** Limit simultaneous provider batches while preserving useful parallelism. */
export const DEFI_LLAMA_SPOT_CONCURRENCY = 2
/** Small arrival window for requests discovered in adjacent async turns. */
export const DEFI_LLAMA_SPOT_BATCH_WINDOW_MS = 5

type Deferred = {
  resolve: (price: SpotPriceResult | null) => void
  reject: (error: unknown) => void
}

type CurrentClient = Pick<DefiLlamaClient, 'getCurrent'>

type Entry = Deferred & {
  key: string
  promise: Promise<SpotPriceResult | null>
  waiters: number
  settled: boolean
  detached: boolean
  batch?: Batch
}

type Batch = {
  entries: Entry[]
  controller: AbortController
}

// All default clients share the same provider gate, including historical
// read-through. A failed batch still settles every member without token retries.
function currentClient(env?: Env): DefiLlamaClient {
  return new DefiLlamaClient(undefined, undefined, {
    env,
    timeoutMs: DEFI_LLAMA_SPOT_TIMEOUT_MS,
    retryRateLimits: false
  })
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    onCancel?.()
    return Promise.reject(signal.reason)
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      onCancel?.()
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function usableCurrentPrice(price: unknown, timestamp: unknown, now: number): boolean {
  return (
    typeof price === 'number' &&
    Number.isFinite(price) &&
    price > 0 &&
    typeof timestamp === 'number' &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0 &&
    now - timestamp <= CURRENT_MAX_AGE_SECONDS &&
    timestamp - now <= CURRENT_MAX_FUTURE_SKEW_SECONDS
  )
}

/**
 * DeFiLlama's current endpoint is batched, but the source contract is a
 * single-token lookup. Calls made in the same turn join one provider request;
 * duplicate keys also share the same in-flight promise. A batch failure is
 * propagated to each member and is never retried as individual requests.
 */
export class DefiLlamaSpotSource extends SpotPriceSourceBase {
  readonly name = 'defillama'
  readonly priority = 15

  private readonly pending = new Map<string, Entry>()
  private readonly inflight = new Map<string, Entry>()
  private flushScheduled = false
  private flushRunning = false
  private flushAgain = false

  constructor(private readonly client: CurrentClient = currentClient()) {
    super()
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined && !DEFILLAMA_UNSUPPORTED_CHAINS.has(chainId)
  }

  getSpotPrice(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPriceResult | null> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const chain = chainIdToName(chainId)
    if (!chain || DEFILLAMA_UNSUPPORTED_CHAINS.has(chainId)) return Promise.resolve(null)

    const now = nowUnix()
    if (isRejectedPrice(chain, token, currentUtcDayEnd(now), this.name)) return Promise.resolve(null)

    const key = `${chain}:${token.toLowerCase()}`
    const existing = this.inflight.get(key)
    if (existing) {
      existing.waiters += 1
      return withSignal(existing.promise, signal, () => this.cancelWaiter(key, existing))
    }

    let resolve!: Deferred['resolve']
    let reject!: Deferred['reject']
    const promise = new Promise<SpotPriceResult | null>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: Entry = {
      key,
      resolve,
      reject,
      promise,
      waiters: 1,
      settled: false,
      detached: false
    }
    this.inflight.set(key, entry)
    this.pending.set(key, entry)
    this.scheduleFlush()
    return withSignal(promise, signal, () => this.cancelWaiter(key, entry))
  }

  private cancelWaiter(key: string, entry: Entry): void {
    if (entry.settled || entry.waiters === 0) return
    entry.waiters -= 1
    if (entry.waiters > 0) return

    if (entry.batch) {
      if (entry.batch.entries.every((candidate) => candidate.waiters === 0)) {
        const reason = new DOMException('All DeFiLlama waiters canceled', 'AbortError')
        entry.batch.controller.abort(reason)
        for (const candidate of entry.batch.entries) {
          this.detachEntry(candidate)
          candidate.settled = true
          candidate.reject(reason)
        }
      }
      return
    }

    this.pending.delete(key)
    this.detachEntry(entry)
    entry.settled = true
    entry.reject(new DOMException('All DeFiLlama waiters canceled', 'AbortError'))
  }

  private detachEntry(entry: Entry): void {
    entry.detached = true
    if (this.inflight.get(entry.key) === entry) this.inflight.delete(entry.key)
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    if (this.flushRunning) {
      this.flushAgain = true
      return
    }
    this.flushScheduled = true
    setTimeout(() => {
      this.flushScheduled = false
      void this.flush()
    }, DEFI_LLAMA_SPOT_BATCH_WINDOW_MS)
  }

  private async flush(): Promise<void> {
    if (this.flushRunning) {
      this.flushAgain = true
      return
    }
    this.flushRunning = true
    try {
      do {
        this.flushAgain = false
        const entries = [...this.pending.values()]
        this.pending.clear()
        if (entries.length === 0) break

        const batches: Entry[][] = []
        for (let index = 0; index < entries.length; index += DEFI_LLAMA_SPOT_BATCH) {
          batches.push(entries.slice(index, index + DEFI_LLAMA_SPOT_BATCH))
        }

        let nextBatch = 0
        const worker = async (): Promise<void> => {
          while (nextBatch < batches.length) {
            const batch = batches[nextBatch++]
            await this.fetchBatch(batch)
          }
        }
        const workerCount = Math.min(DEFI_LLAMA_SPOT_CONCURRENCY, batches.length)
        await Promise.all(Array.from({ length: workerCount }, () => worker()))
      } while (this.pending.size > 0 || this.flushAgain)
    } finally {
      this.flushRunning = false
      if (this.pending.size > 0) this.scheduleFlush()
    }
  }

  private async fetchBatch(entries: Entry[]): Promise<void> {
    const pairs = entries.filter((entry) => !entry.detached).map((entry) => [entry.key, entry] as const)
    if (pairs.length === 0) return
    const keys = pairs.map(([key]) => key)
    const batch: Batch = { entries, controller: new AbortController() }
    for (const entry of entries) entry.batch = batch
    try {
      const timeout = AbortSignal.timeout(DEFI_LLAMA_SPOT_TIMEOUT_MS)
      const signal = AbortSignal.any([timeout, batch.controller.signal])
      const response = await this.client.getCurrent(keys, signal)
      if (
        response === null ||
        typeof response !== 'object' ||
        response.coins === null ||
        typeof response.coins !== 'object' ||
        Array.isArray(response.coins)
      ) {
        throw new ApiError('UNAVAILABLE', 'Malformed DeFiLlama current response envelope')
      }
      const now = nowUnix()
      for (const [key, entry] of pairs) {
        if (entry.detached) continue
        const price = toHistoricalPrice(response.coins?.[key], (value, timestamp) =>
          usableCurrentPrice(value, timestamp, now)
        )
        entry.settled = true
        entry.resolve(price)
      }
    } catch (error) {
      for (const entry of entries) {
        if (entry.detached) continue
        entry.settled = true
        entry.reject(error)
      }
    }
  }
}

export function createDefiLlamaSpotSource(client?: CurrentClient, env?: Env): DefiLlamaSpotSource {
  return new DefiLlamaSpotSource(client ?? currentClient(env))
}
