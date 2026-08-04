import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import { getDailyPriceProgressSnapshot, handleDailyPriceProgress } from '../src/daily-price-progress'

function progressPool() {
  const query = vi.fn()
    .mockResolvedValueOnce({
      rows: [{
        started_at: '2026-08-01T10:00:00.000Z',
        last_activity_at: '2026-08-01T10:09:30.000Z',
        total: '100',
        attempted: '48',
        pending: '50',
        in_progress: '5',
        priced: '35',
        unsupported: '7',
        retryable: '2',
        quarantined: '1',
        active_leases: '4',
        expired_leases: '1',
        completed_1m: '8',
        completed_5m: '30',
        completed_15m: '43',
      }],
    })
    .mockResolvedValueOnce({
      rows: [{
        chain: 'ethereum',
        total: '100',
        pending: '50',
        in_progress: '5',
        priced: '35',
        unsupported: '7',
        retryable: '2',
        quarantined: '1',
      }],
    })
    .mockResolvedValueOnce({ rows: [{ adapter: 'defillama-historical', count: '34' }, { adapter: 'erc4626', count: '1' }] })
    .mockResolvedValueOnce({ rows: [{ adapter: 'defillama', count: '34' }, { adapter: 'derived', count: '1' }] })
    .mockResolvedValueOnce({ rows: [{ adapter: 'near-eod', count: '35' }] })
    .mockResolvedValueOnce({
      rows: [{
        status: 'unsupported',
        failure_class: 'unsupported',
        resolution_failure: 'unsupported',
        count: '7',
      }],
    })
    .mockResolvedValueOnce({
      rows: [{
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000001',
        eod_at: '2025-01-01T23:59:59.000Z',
        status: 'in_progress',
        adapter: null,
        failure_class: null,
        resolution_failure: null,
        last_attempt_at: '2026-08-01T10:09:20.000Z',
        lease_expires_at: '2026-08-01T10:19:20.000Z',
      }],
    })
    .mockResolvedValueOnce({
      rows: [{
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000002',
        eod_at: '2025-01-02T23:59:59.000Z',
        status: 'priced',
        adapter: 'defillama-historical',
        failure_class: null,
        resolution_failure: null,
        failure_reason: 'HTTP 503 from https://rpc.example/key=secret',
        updated_at: '2026-08-01T10:09:25.000Z',
      }],
    })
  return { query, pool: { query } as unknown as Pool }
}

describe('daily price progress snapshot', () => {
  test('reports live queue semantics, rolling throughput, and ETA', async () => {
    const { pool } = progressPool()
    const nowTimestamp = Date.parse('2026-08-01T10:10:00.000Z') / 1_000

    const snapshot = await getDailyPriceProgressSnapshot(pool, nowTimestamp)

    expect(snapshot).toMatchObject({
      generatedAt: nowTimestamp,
      state: 'running',
      queue: {
        total: 100,
        resolved: 43,
        remaining: 57,
        priced: 35,
        activeLeases: 4,
        expiredLeases: 1,
        completionPercent: 43,
      },
      activity: {
        ratePerMinute: { oneMinute: 8, fiveMinutes: 6 },
        etaSeconds: 570,
      },
      adapters: [
        { adapter: 'defillama-historical', count: 34 },
        { adapter: 'erc4626', count: 1 },
      ],
      sources: [
        { source: 'defillama', count: 34 },
        { source: 'derived', count: 1 },
      ],
      qualities: [{ quality: 'near-eod', count: 35 }],
      failures: [{
        status: 'unsupported',
        failureClass: 'unsupported',
        resolutionFailure: 'unsupported',
        count: 7,
      }],
    })
  })

  test('returns a no-store response and sanitizes precise failure messages', async () => {
    const { query, pool } = progressPool()

    const response = await handleDailyPriceProgress(pool)
    const body = await response.text()

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(body).toContain('failureReason')
    expect(body).not.toContain('failure_reason')
    expect(body).toContain('<redacted-url>')
    expect(body).not.toContain('rpc.example')
    expect(query).toHaveBeenCalledTimes(8)
    const sql = query.mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain("'cycle', 'max-depth'")
    expect(sql).not.toContain("'cyclic'")
    expect(sql).not.toContain("'over-depth'")
  })
})
