import { describe, expect, it, vi } from 'vitest'
import {
  claimRepairQueue,
  enqueueRepairTargets,
  MAX_INVALID_ATTEMPTS,
  type RepairLease,
  type RepairQueueDb,
  readFinalizedRepairKeys,
  releaseRepairLease,
  repairRetryDelaySeconds,
  settleRepairFailure,
  settleRepairSuccess
} from '../../src/db/repair-queue'

const TOKEN = '0x0000000000000000000000000000000000000001'
const DAY = 1_700_006_399

function db(
  responses: Array<{ rows: Record<string, unknown>[]; rowCount?: number }>
): RepairQueueDb & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn()
  for (const response of responses) query.mockResolvedValueOnce(response)
  return { query } as RepairQueueDb & { query: ReturnType<typeof vi.fn> }
}

describe('historical repair queue', () => {
  it('uses finalized accepted rows as target-level completion', async () => {
    const database = db([{ rows: [{ chain_id: 1, token: TOKEN, timestamp: new Date(DAY * 1_000) }] }])
    const keys = await readFinalizedRepairKeys(database, [{ chainId: 1, token: TOKEN, timestamp: DAY }], DAY + 10)
    expect(keys).toEqual(new Set([`1:${TOKEN}:${DAY}`]))
    expect(database.query.mock.calls[0][0]).toContain('tp.finalized = TRUE')
    expect(database.query.mock.calls[0][0]).toContain('NOT EXISTS')
  })

  it('does not enqueue a target that already has a finalized source', async () => {
    const database = db([{ rows: [{ chain_id: 1, token: TOKEN, timestamp: new Date(DAY * 1_000) }] }])
    await expect(
      enqueueRepairTargets(database, [{ chainId: 1, token: TOKEN, timestamp: DAY }], DAY + 10)
    ).resolves.toBe(0)
    expect(database.query).toHaveBeenCalledTimes(1)
  })

  it('reopens a completed row when its finalized evidence is gone', async () => {
    const database = db([{ rows: [] }, { rows: [], rowCount: 1 }])
    await expect(
      enqueueRepairTargets(database, [{ chainId: 1, token: TOKEN, timestamp: DAY }], DAY + 10)
    ).resolves.toBe(1)
    const sql = String(database.query.mock.calls[1][0])
    expect(sql).toContain('ON CONFLICT (token, "timestamp", chain_id) DO UPDATE SET')
    expect(sql).toContain('completed_at = NULL, attempts = 0, next_attempt_at = NOW()')
    expect(sql).toContain('lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL')
    expect(sql).toContain('last_outcome = NULL, last_error = NULL')
    expect(sql).toMatch(
      /WHERE historical_price_repair_queue\.completed_at IS NOT NULL AND .*last_outcome IS DISTINCT FROM 'invalid'/
    )
  })

  it('parks an invalid target after the attempt cap instead of retrying forever', async () => {
    const lease: RepairLease = {
      chainId: 1,
      token: TOKEN,
      timestamp: DAY,
      attempts: MAX_INVALID_ATTEMPTS - 1,
      nextAttemptAt: DAY,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: DAY + 60,
      lastOutcome: 'invalid',
      lastError: null
    }
    const parkedDb = db([{ rows: [], rowCount: 1 }])
    await settleRepairFailure(parkedDb, lease, 'invalid', 'rejected')
    expect(parkedDb.query.mock.calls[0][0]).toContain('completed_at = CASE WHEN $9::boolean THEN NOW() ELSE NULL END')
    expect(parkedDb.query.mock.calls[0][1][8]).toBe(true)

    const retryDb = db([{ rows: [], rowCount: 1 }])
    await settleRepairFailure(retryDb, { ...lease, attempts: 0 }, 'invalid', 'rejected')
    expect(retryDb.query.mock.calls[0][1][8]).toBe(false)

    const transientDb = db([{ rows: [], rowCount: 1 }])
    await settleRepairFailure(transientDb, { ...lease, attempts: 99 }, 'retryable', 'timeout')
    expect(transientDb.query.mock.calls[0][1][8]).toBe(false)
  })

  it('claims due work with a lease token and skips locked rows', async () => {
    const database = db([
      {
        rows: [
          {
            chain_id: 1,
            token: TOKEN,
            timestamp: new Date(DAY * 1_000),
            attempts: 2,
            next_attempt_at: new Date((DAY + 1) * 1_000),
            lease_owner: 'worker-a',
            lease_token: 'lease-a',
            lease_expires_at: new Date((DAY + 60) * 1_000),
            last_outcome: 'retryable',
            last_error: 'timeout'
          }
        ]
      }
    ])
    const [claim] = await claimRepairQueue(database, {
      limit: 1,
      owner: 'worker-a',
      leaseSeconds: 60,
      leaseToken: 'lease-a'
    })
    expect(claim).toMatchObject({
      chainId: 1,
      token: TOKEN,
      attempts: 2,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a'
    })
    expect(database.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED')
  })

  it('uses a slower retry schedule for provider misses', () => {
    expect(repairRetryDelaySeconds('retryable', 0)).toBe(60)
    expect(repairRetryDelaySeconds('missing', 0)).toBe(300)
    expect(repairRetryDelaySeconds('missing', 99)).toBeGreaterThan(repairRetryDelaySeconds('retryable', 99))
  })

  it('settles only with the current lease and releases cancellation without charging attempts', async () => {
    const lease: RepairLease = {
      chainId: 1,
      token: TOKEN,
      timestamp: DAY,
      attempts: 0,
      nextAttemptAt: DAY,
      leaseOwner: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: DAY + 60,
      lastOutcome: null,
      lastError: null
    }
    const successDb = db([{ rows: [], rowCount: 1 }])
    await expect(settleRepairSuccess(successDb, lease)).resolves.toBe(true)
    expect(successDb.query.mock.calls[0][0]).toContain('lease_token = $5')
    expect(successDb.query.mock.calls[0][0]).toContain('tp.finalized = TRUE')

    const releaseDb = db([{ rows: [], rowCount: 1 }])
    await expect(releaseRepairLease(releaseDb, lease)).resolves.toBe(true)

    const failureDb = db([{ rows: [], rowCount: 1 }])
    await expect(settleRepairFailure(failureDb, lease, 'retryable', 'timeout')).resolves.toBe(true)
    expect(failureDb.query.mock.calls[0][1]).toContain('timeout')
  })
})
