import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { processClaims } from '../../scripts/repair-historical-prices'
import type { RepairLease, RepairQueueDb } from '../../src/db/repair-queue'

const mocks = vi.hoisted(() => ({
  finalizedRepairKeys: vi.fn(),
  offlineProvider: vi.fn(() => ({})),
  runGraphBackfill: vi.fn()
}))

vi.mock('../../scripts/lib/graph-backfill', () => ({ runGraphBackfill: mocks.runGraphBackfill }))
vi.mock('../../scripts/lib/historical-repair', () => ({ finalizedRepairKeys: mocks.finalizedRepairKeys }))
vi.mock('../../scripts/lib/offline-provider', () => ({ offlineProvider: mocks.offlineProvider }))

const TOKEN_A = '0x0000000000000000000000000000000000000001'
const TOKEN_B = '0x0000000000000000000000000000000000000002'
const TOKEN_C = '0x0000000000000000000000000000000000000003'

function lease(token: string): RepairLease {
  return {
    chainId: 1,
    token,
    timestamp: 1_700_006_399,
    attempts: 2,
    nextAttemptAt: 1_700_006_400,
    leaseOwner: 'worker',
    leaseToken: `lease-${token.slice(-1)}`,
    leaseExpiresAt: 1_700_007_000,
    lastOutcome: 'retryable',
    lastError: 'previous provider failure'
  }
}

function db(): RepairQueueDb & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
  return { query } as RepairQueueDb & { query: ReturnType<typeof vi.fn> }
}

describe('historical repair worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('settles claims finalized before a budget abort and releases the rest unchanged', async () => {
    const controller = new AbortController()
    const database = db()
    const first = lease(TOKEN_A)
    const second = lease(TOKEN_B)
    mocks.finalizedRepairKeys.mockResolvedValueOnce(new Set([`1:${TOKEN_A}:${first.timestamp}`]))
    mocks.runGraphBackfill.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      controller.abort(new Error('Historical repair runtime budget exhausted'))
      signal.throwIfAborted()
    })

    const result = await processClaims(database, [first, second], {
      write: true,
      deadline: Date.now() + 60_000,
      concurrency: 1,
      providerRps: 1,
      evidenceDir: '/tmp/repair-worker-test',
      signal: controller.signal
    })

    expect(result).toEqual({ completed: 1, missing: 0, unresolved: 0, invalid: 0, errors: 0, deferred: 1 })
    expect(database.query).toHaveBeenCalledTimes(2)
    expect(String(database.query.mock.calls[0][0])).toContain('completed_at = NOW()')
    expect(String(database.query.mock.calls[1][0])).toContain('lease_owner = NULL')
    expect(String(database.query.mock.calls[1][0])).not.toContain('attempts = attempts + 1')
    expect(String(database.query.mock.calls[1][0])).not.toContain('next_attempt_at =')
    expect(String(database.query.mock.calls[1][0])).not.toContain('last_outcome =')
  })

  it('counts a non-budget graph exception as an actionable retry error', async () => {
    const database = db()
    const claim = lease(TOKEN_A)
    mocks.finalizedRepairKeys.mockResolvedValueOnce(new Set())
    mocks.runGraphBackfill.mockRejectedValueOnce(new Error('provider unavailable'))

    const result = await processClaims(database, [claim], {
      write: true,
      deadline: Date.now() + 60_000,
      concurrency: 1,
      providerRps: 1,
      evidenceDir: '/tmp/repair-worker-test',
      signal: new AbortController().signal
    })

    expect(result).toEqual({ completed: 0, missing: 0, unresolved: 0, invalid: 0, errors: 1, deferred: 0 })
    expect(String(database.query.mock.calls[0][0])).toContain('attempts = attempts + 1')
  })

  it('bisects a failed group so only the failing target is charged an attempt', async () => {
    const database = db()
    const good = lease(TOKEN_A)
    const bad = lease(TOKEN_B)
    mocks.runGraphBackfill
      .mockRejectedValueOnce(new Error('Missing graph root'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Missing graph root'))
    mocks.finalizedRepairKeys
      .mockResolvedValueOnce(new Set([`1:${TOKEN_A}:${good.timestamp}`]))
      .mockResolvedValueOnce(new Set())

    const result = await processClaims(database, [good, bad], {
      write: true,
      deadline: Date.now() + 60_000,
      concurrency: 1,
      providerRps: 1,
      evidenceDir: mkdtempSync(join(tmpdir(), 'repair-worker-')),
      signal: new AbortController().signal
    })

    expect(result).toEqual({ completed: 1, missing: 0, unresolved: 0, invalid: 0, errors: 1, deferred: 0 })
    expect(mocks.runGraphBackfill).toHaveBeenCalledTimes(3)
    expect(mocks.runGraphBackfill.mock.calls[1][0].manifest.targets).toHaveLength(1)
    expect(String(database.query.mock.calls[0][0])).toContain('completed_at = NOW()')
    expect(database.query.mock.calls[0][1][1]).toBe(TOKEN_A)
    expect(String(database.query.mock.calls[1][0])).toContain('attempts = attempts + 1')
    expect(database.query.mock.calls[1][1][1]).toBe(TOKEN_B)
  })

  it('releases a group when cancellation arrives after graph completion', async () => {
    const controller = new AbortController()
    const database = db()
    const claim = lease(TOKEN_A)
    mocks.finalizedRepairKeys.mockResolvedValueOnce(new Set())
    mocks.runGraphBackfill.mockImplementationOnce(async () => {
      controller.abort(new Error('Historical repair runtime budget exhausted'))
    })

    const result = await processClaims(database, [claim], {
      write: true,
      deadline: Date.now() + 60_000,
      concurrency: 1,
      providerRps: 1,
      evidenceDir: '/tmp/repair-worker-test',
      signal: controller.signal
    })

    expect(result).toEqual({ completed: 0, missing: 0, unresolved: 0, invalid: 0, errors: 0, deferred: 1 })
    expect(String(database.query.mock.calls[0][0])).toContain('lease_owner = NULL')
  })

  it('reports graph cutoffs as expected unresolved work without failing the worker', async () => {
    const database = db()
    const claims = [lease(TOKEN_A), lease(TOKEN_B), lease(TOKEN_C)]
    const evidenceDir = mkdtempSync(join(tmpdir(), 'repair-worker-'))
    mocks.finalizedRepairKeys.mockResolvedValueOnce(new Set())
    mocks.runGraphBackfill.mockImplementationOnce(async ({ out }: { out: string }) => {
      writeFileSync(
        out,
        claims
          .map((claim, index) =>
            JSON.stringify({
              type: 'target-outcome',
              target: { chainId: claim.chainId, token: claim.token, eodTimestamp: claim.timestamp },
              status: 'unresolved',
              reason: ['cycle', 'max-depth', 'budget'][index]
            })
          )
          .join('\n')
      )
    })

    const result = await processClaims(database, claims, {
      write: true,
      deadline: Date.now() + 60_000,
      concurrency: 1,
      providerRps: 1,
      evidenceDir,
      signal: new AbortController().signal
    })

    expect(result).toEqual({ completed: 0, missing: 0, unresolved: 3, invalid: 0, errors: 0, deferred: 0 })
    expect(database.query).toHaveBeenCalledTimes(3)
  })
})

it('leaves attempts unchanged when the drain deadline is reached before new graph work', async () => {
  const database = db()
  mocks.runGraphBackfill.mockClear()
  const result = await processClaims(database, [lease(TOKEN_A), lease(TOKEN_B)], {
    write: true,
    deadline: Date.now() - 1,
    concurrency: 1,
    providerRps: 1,
    evidenceDir: '/tmp/repair-worker-test',
    signal: new AbortController().signal
  })
  expect(mocks.runGraphBackfill).not.toHaveBeenCalled()
  expect(result.deferred).toBe(2)
  for (const [sql] of database.query.mock.calls) {
    expect(sql).toContain('lease_owner = NULL')
    expect(sql).not.toContain('attempts = attempts + 1')
  }
})
