import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import {
  processDailyPriceTarget,
  runDailyPriceWorker,
  type DailyPriceResolver,
} from '../src/daily-price-worker'
import type { DailyPriceProgress, DailyPriceTarget } from '../src/daily-prices'
import type { ResolvedPricePath } from '../src/recursive-pricing'

const TOKEN = '0x0000000000000000000000000000000000000001'
const SECOND_TOKEN = '0x0000000000000000000000000000000000000002'
const REQUESTED_TIMESTAMP = 1_700_006_399
const pool = {} as Pool

function target(overrides: Partial<DailyPriceTarget> = {}): DailyPriceTarget {
  return {
    id: 1,
    chain: 'ethereum',
    token: TOKEN,
    eodTimestamp: REQUESTED_TIMESTAMP,
    status: 'in_progress',
    attemptCount: 1,
    adapter: null,
    failureClass: null,
    failureReason: null,
    metadata: {},
    ...overrides,
  }
}

function path(overrides: Partial<ResolvedPricePath> = {}): ResolvedPricePath {
  return {
    chain: 'ethereum',
    token: TOKEN,
    requestedTimestamp: REQUESTED_TIMESTAMP,
    observedTimestamp: REQUESTED_TIMESTAMP - 60,
    priceUsd: 100,
    symbol: 'TEST',
    confidence: 0.99,
    source: 'defillama',
    adapter: 'defillama-historical',
    classification: 'observed',
    quality: 'near-eod',
    blockNumber: null,
    inputs: [],
    metadata: { provider: 'defillama' },
    ...overrides,
  }
}

function progress(overrides: Partial<DailyPriceProgress> = {}): DailyPriceProgress {
  return {
    startedTimestamp: REQUESTED_TIMESTAMP,
    total: 2,
    attempted: 2,
    remaining: 0,
    pending: 0,
    inProgress: 0,
    priced: 1,
    unsupported: 1,
    retryable: 0,
    quarantined: 0,
    adapterCounts: { 'defillama-historical': 1 },
    ...overrides,
  }
}

describe('daily price target processor', () => {
  test('persists validated evidence before marking a target priced', async () => {
    const insertPrices = vi.fn().mockResolvedValue(undefined)
    const recordOutcome = vi.fn().mockResolvedValue(undefined)
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockResolvedValue({ path: path(), failure: null }),
    }

    const outcome = await processDailyPriceTarget(pool, resolver, target(), {}, {
      insertPrices,
      recordOutcome,
    })

    expect(insertPrices).toHaveBeenCalledWith(pool, [expect.objectContaining({
      timestamp: REQUESTED_TIMESTAMP,
      observedTimestamp: REQUESTED_TIMESTAMP - 60,
      price: 100,
      classification: 'observed',
      validationStatus: 'validated',
    })])
    expect(recordOutcome).toHaveBeenCalledWith(pool, 1, 1, expect.objectContaining({
      status: 'priced',
      adapter: 'defillama-historical',
      metadata: expect.objectContaining({ observationDistance: 60 }),
    }))
    expect(outcome.status).toBe('priced')
  })

  test('schedules retryable failures without treating them as unsupported', async () => {
    const recordOutcome = vi.fn().mockResolvedValue(undefined)
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockResolvedValue({
        path: null,
        failure: {
          reason: 'retryable',
          token: TOKEN,
          attempts: [{
            adapter: 'historical-market-price',
            reason: 'retryable',
            error: 'HTTP 503',
          }],
        },
      }),
    }

    const outcome = await processDailyPriceTarget(pool, resolver, target(), {
      nowTimestamp: REQUESTED_TIMESTAMP,
      retryDelaySeconds: 600,
    }, { recordOutcome })

    expect(outcome).toMatchObject({
      status: 'retryable',
      nextRetryTimestamp: REQUESTED_TIMESTAMP + 600,
    })
    expect(recordOutcome).toHaveBeenCalledOnce()
  })

  test('quarantines invalid paths with their precise attempts', async () => {
    const recordOutcome = vi.fn().mockResolvedValue(undefined)
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockResolvedValue({
        path: null,
        failure: {
          reason: 'invalid',
          token: TOKEN,
          attempts: [{ adapter: 'pool-nav', reason: 'invalid', error: 'missing constituent' }],
        },
      }),
    }

    const outcome = await processDailyPriceTarget(pool, resolver, target(), {}, { recordOutcome })

    expect(outcome).toMatchObject({
      status: 'quarantined',
      failureClass: 'invalid',
      failureReason: 'pool-nav (invalid): missing constituent',
    })
  })
})

describe('daily price worker', () => {
  test('validates configuration before claiming any targets', async () => {
    const operations: string[] = []
    const configurationError = new Error('RPC configuration invalid')
    const validateConfiguration = vi.fn().mockImplementation(async () => {
      operations.push('validate')
      throw configurationError
    })
    const claimTargets = vi.fn().mockImplementation(async () => {
      operations.push('claim')
      return []
    })

    await expect(runDailyPriceWorker(pool, { resolve: vi.fn() }, {}, {
      validateConfiguration,
      claimTargets,
    })).rejects.toBe(configurationError)

    expect(operations).toEqual(['validate'])
    expect(claimTargets).not.toHaveBeenCalled()
  })

  test('continues past unsupported targets and reports a durable final snapshot', async () => {
    const unsupported = target()
    const priced = target({ id: 2, token: SECOND_TOKEN })
    const claimTargets = vi.fn()
      .mockResolvedValueOnce([unsupported, priced])
      .mockResolvedValueOnce([])
    const recordOutcome = vi.fn().mockResolvedValue(undefined)
    const insertPrices = vi.fn().mockResolvedValue(undefined)
    const loadProgress = vi.fn().mockResolvedValue(progress())
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockImplementation(async request => request.token === TOKEN
        ? {
            path: null,
            failure: { reason: 'unsupported', token: TOKEN, attempts: [] },
          }
        : {
            path: path({ token: SECOND_TOKEN }),
            failure: null,
          }),
    }

    const summary = await runDailyPriceWorker(pool, resolver, {
      batchSize: 2,
      maxTargets: 10,
      progressEvery: 2,
    }, {
      claimTargets,
      recordOutcome,
      insertPrices,
      loadProgress,
    })

    expect(summary).toMatchObject({
      processed: 2,
      claimedBatches: 1,
      progress: { remaining: 0, priced: 1, unsupported: 1 },
    })
    expect(recordOutcome.mock.calls.map(call => call[3].status)).toEqual(['unsupported', 'priced'])
    expect(recordOutcome.mock.calls[1][3]).toMatchObject({
      metadata: { classification: 'observed' },
    })
    expect(claimTargets).toHaveBeenCalledTimes(2)
  })

  test('processes a claimed batch with bounded concurrency', async () => {
    const targets = Array.from({ length: 4 }, (_, index) => target({
      id: index + 1,
      token: `0x${String(index + 1).padStart(40, '0')}`,
    }))
    const claimTargets = vi.fn()
      .mockResolvedValueOnce(targets)
      .mockResolvedValueOnce([])
    let active = 0
    let maximumActive = 0
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockImplementation(async request => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
        return {
          path: null,
          failure: { reason: 'unsupported', token: request.token, attempts: [] },
        }
      }),
    }

    const summary = await runDailyPriceWorker(pool, resolver, {
      batchSize: 4,
      concurrency: 2,
      maxTargets: 4,
    }, {
      claimTargets,
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      loadProgress: vi.fn().mockResolvedValue(progress({ total: 4, unsupported: 4, priced: 0 })),
    })

    expect(summary.processed).toBe(4)
    expect(maximumActive).toBe(2)
    expect(resolver.resolve).toHaveBeenCalledTimes(4)
  })

  test('prefetches each claimed batch before resolving targets', async () => {
    const claimed = [target(), target({ id: 2, token: SECOND_TOKEN })]
    const operations: string[] = []
    const resolver: DailyPriceResolver = {
      prefetch: vi.fn().mockImplementation(async () => {
        operations.push('prefetch')
      }),
      resolve: vi.fn().mockImplementation(async request => {
        operations.push(`resolve:${request.token}`)
        return {
          path: null,
          failure: { reason: 'unsupported', token: request.token, attempts: [] },
        }
      }),
    }

    await runDailyPriceWorker(pool, resolver, { batchSize: 2, maxTargets: 2 }, {
      claimTargets: vi.fn().mockResolvedValueOnce(claimed),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
      loadProgress: vi.fn().mockResolvedValue(progress({ priced: 0, unsupported: 2 })),
    })

    expect(resolver.prefetch).toHaveBeenCalledWith(claimed.map(item => ({
      chain: item.chain,
      token: item.token,
      requestedTimestamp: item.eodTimestamp,
      blockNumber: null,
    })))
    expect(operations[0]).toBe('prefetch')
  })

  test('batches evidence before recording durable outcomes', async () => {
    const claimed = [target(), target({ id: 2, token: SECOND_TOKEN })]
    const operations: string[] = []
    const insertPrices = vi.fn().mockImplementation(async () => {
      operations.push('evidence')
    })
    const recordOutcomes = vi.fn().mockImplementation(async () => {
      operations.push('outcomes')
    })
    const resolver: DailyPriceResolver = {
      resolve: vi.fn().mockImplementation(async request => ({
        path: path({ token: request.token }),
        failure: null,
      })),
    }

    await runDailyPriceWorker(pool, resolver, { batchSize: 2, concurrency: 2, maxTargets: 2 }, {
      claimTargets: vi.fn().mockResolvedValueOnce(claimed),
      insertPrices,
      recordOutcomes,
      loadProgress: vi.fn().mockResolvedValue(progress({ priced: 2, unsupported: 0 })),
    })

    expect(insertPrices).toHaveBeenCalledOnce()
    expect(insertPrices.mock.calls[0][1]).toHaveLength(2)
    expect(recordOutcomes).toHaveBeenCalledOnce()
    expect(recordOutcomes.mock.calls[0][1]).toHaveLength(2)
    expect(operations).toEqual(['evidence', 'outcomes'])
  })
})
