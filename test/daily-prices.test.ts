import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import {
  buildDailyPriceProgressSnapshot,
  claimDailyPriceTargets,
  enqueueDailyPriceTargets,
  getDailyPriceProgress,
  normalizeDailyPriceTarget,
  recordDailyPriceOutcome,
  recordDailyPriceOutcomes,
} from '../src/daily-prices'

const TOKEN = '0x0000000000000000000000000000000000000001'

describe('daily price queue', () => {
  test('enqueues targets idempotently', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] })
    const pool = { query } as unknown as Pool
    const target = {
      chain: 'ethereum',
      token: TOKEN,
      eodTimestamp: 1_700_000_000,
    }

    const inserted = await enqueueDailyPriceTargets(pool, [target, target])

    expect(inserted).toBe(1)
    expect(query).toHaveBeenCalledOnce()
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (chain, token, eod_at) DO NOTHING')
    expect(params).toHaveLength(4)
    expect(params).toContain('2023-11-14T23:59:59.000Z')
  })

  test('normalizes intraday inputs to the exact UTC day end', () => {
    expect(normalizeDailyPriceTarget({
      chain: 'Ethereum',
      token: TOKEN,
      eodTimestamp: 1_700_000_000,
    }, 1_700_100_000)).toMatchObject({
      chain: 'ethereum',
      eodTimestamp: 1_700_006_399,
    })
  })

  test('rejects a target before its UTC day has closed', () => {
    expect(() => normalizeDailyPriceTarget({
      chain: 'ethereum',
      token: TOKEN,
      eodTimestamp: 1_700_000_000,
    }, 1_700_000_100)).toThrow('closed UTC day')
  })

  test('claims a bounded starvation-free batch and reclaims expired leases', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '7',
          chain: 'ethereum',
          token: TOKEN,
          eod_at: '2023-11-14T23:59:59.000Z',
          status: 'in_progress',
          attempt_count: 1,
          adapter: null,
          failure_class: null,
          failure_reason: null,
          metadata: {},
        },
      ],
    })

    const targets = await claimDailyPriceTargets({ query } as unknown as Pool, 25, {
      nowTimestamp: 1_700_000_100,
      leaseSeconds: 120,
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('WITH exhausted AS')
    expect(sql).toContain("status = 'quarantined'")
    expect(sql).toContain("'originalFailureClass', 'retryable'")
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("status = 'retryable'")
    expect(sql).toContain('attempt_count < $4')
    expect(sql).toContain("status = 'in_progress' AND lease_expires_at <=")
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("CASE status WHEN 'pending' THEN 0")
    expect(params).toEqual([25, '2023-11-14T22:15:00.000Z', 120, 3])
    expect(targets[0]).toMatchObject({
      id: 7,
      status: 'in_progress',
      eodTimestamp: 1_700_006_399,
    })
  })

  test('marks unsupported targets terminal so they cannot starve later work', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 7 }] })

    await recordDailyPriceOutcome({ query } as unknown as Pool, 7, 1, {
      status: 'unsupported',
      adapter: 'erc-4626',
      failureReason: 'Contract does not implement the required interface',
    })

    const [, params] = query.mock.calls[0]
    expect(params).toEqual(expect.arrayContaining([
      7,
      1,
      'unsupported',
      'unsupported',
      'Contract does not implement the required interface',
    ]))
  })

  test('keeps retryable failures eligible after an explicit delay', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 8 }] })

    await recordDailyPriceOutcome({ query } as unknown as Pool, 8, 2, {
      status: 'retryable',
      failureReason: 'RPC returned HTTP 503',
      nextRetryTimestamp: 1_700_000_600,
    })

    const [, params] = query.mock.calls[0]
    expect(params).toEqual(expect.arrayContaining([
      8,
      2,
      'retryable',
      'retryable',
      'RPC returned HTTP 503',
      '2023-11-14T22:23:20.000Z',
    ]))
  })

  test('rejects stale workers after a target is reclaimed', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })

    await expect(recordDailyPriceOutcome({ query } as unknown as Pool, 9, 1, {
      status: 'priced',
      adapter: 'erc-4626',
    })).rejects.toThrow('attempt 1 is not currently leased')

    const [sql] = query.mock.calls[0]
    expect(sql).toContain("attempt_count = $2 AND status = 'in_progress'")
  })

  test('records multiple leased outcomes in one update', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 7 }, { id: 8 }] })

    await recordDailyPriceOutcomes({ query } as unknown as Pool, [
      {
        targetId: 7,
        attemptCount: 1,
        outcome: { status: 'priced', adapter: 'defillama-historical' },
      },
      {
        targetId: 8,
        attemptCount: 2,
        outcome: {
          status: 'unsupported',
          failureReason: 'No adapter supports this token',
          metadata: { resolutionFailure: 'unsupported' },
        },
      },
    ])

    expect(query).toHaveBeenCalledOnce()
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('WITH outcomes(')
    expect(sql).toContain("target.status = 'in_progress'")
    expect(params).toHaveLength(18)
    expect(params).toEqual(expect.arrayContaining([
      7,
      'priced',
      'defillama-historical',
      8,
      'unsupported',
      'No adapter supports this token',
      JSON.stringify({ resolutionFailure: 'unsupported' }),
    ]))
  })

  test('rejects an outcome batch when any lease is stale', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })

    await expect(recordDailyPriceOutcomes({ query } as unknown as Pool, [
      { targetId: 7, attemptCount: 1, outcome: { status: 'priced', adapter: 'defillama-historical' } },
      { targetId: 8, attemptCount: 1, outcome: { status: 'priced', adapter: 'defillama-historical' } },
    ])).rejects.toThrow('updated 0 of 2 leased targets')
  })

  test('reports durable progress, outcomes, adapters, elapsed time, and rate', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          started_at: '2023-11-14T22:13:20.000Z',
          total: '10',
          attempted: '7',
          pending: '3',
          in_progress: '1',
          priced: '4',
          unsupported: '1',
          retryable: '1',
          quarantined: '0',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ adapter: 'erc-4626', count: '4' }] })

    const progress = await getDailyPriceProgress({ query } as unknown as Pool)
    const snapshot = buildDailyPriceProgressSnapshot(
      progress,
      { chain: 'ethereum', token: TOKEN, eodTimestamp: 1_700_006_399 },
      1_700_000_100,
    )

    expect(snapshot).toMatchObject({
      total: 10,
      attempted: 7,
      remaining: 5,
      priced: 4,
      unsupported: 1,
      retryable: 1,
      adapterCounts: { 'erc-4626': 4 },
      elapsedSeconds: 100,
      processingRate: 0.07,
      current: { chain: 'ethereum', token: TOKEN, eodTimestamp: 1_700_006_399 },
    })
  })
})
