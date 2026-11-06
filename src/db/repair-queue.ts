import { NOT_REJECTED_PRICE_SQL } from '../prices/rejections'
import { chainIdToName } from '../utils/chains'
import { isClosedDay, pgTimestampToUnix, unixToIsoTimestamp } from '../utils/time'

export interface RepairQueueDb {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>
}

export interface RepairTarget {
  chainId: number
  token: string
  timestamp: number
}

export type RepairOutcome = 'missing' | 'retryable' | 'invalid'

export interface RepairQueueItem extends RepairTarget {
  attempts: number
  nextAttemptAt: number
  leaseOwner: string | null
  leaseToken: string | null
  leaseExpiresAt: number | null
  lastOutcome: RepairOutcome | null
  lastError: string | null
}

export interface RepairLease extends RepairQueueItem {
  leaseOwner: string
  leaseToken: string
}

const MAX_QUEUE_KEYS_PER_QUERY = 1_000
const TRANSIENT_BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600, 86_400]
const MISSING_BACKOFF_SECONDS = [300, 1_800, 10_800, 43_200, 172_800, 604_800]

export function repairRetryDelaySeconds(outcome: RepairOutcome, attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error('attempts must be a non-negative integer')
  const schedule = outcome === 'missing' ? MISSING_BACKOFF_SECONDS : TRANSIENT_BACKOFF_SECONDS
  return schedule[Math.min(attempts, schedule.length - 1)]
}

function targetKey(target: RepairTarget): string {
  return `${target.chainId}:${target.token.toLowerCase()}:${target.timestamp}`
}

function normalizeTarget(target: RepairTarget, now: number): RepairTarget {
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0 || !chainIdToName(target.chainId)) {
    throw new Error(`Unsupported repair target chain: ${target.chainId}`)
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(target.token)) {
    throw new Error(`Invalid repair target token: ${target.token}`)
  }
  if (!Number.isSafeInteger(target.timestamp) || target.timestamp <= 0 || !isClosedDay(target.timestamp, now)) {
    throw new Error(`Repair target must be a closed UTC day: ${target.chainId}:${target.token}:${target.timestamp}`)
  }
  const normalizedTimestamp = Math.floor(target.timestamp / 86_400) * 86_400 + 86_399
  if (normalizedTimestamp !== target.timestamp) {
    throw new Error(`Repair target must be normalized to UTC day end: ${target.timestamp}`)
  }
  return { chainId: target.chainId, token: target.token.toLowerCase(), timestamp: target.timestamp }
}

function buildTargetValues(targets: RepairTarget[]): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = []
  const values = targets.map((target) => {
    const offset = params.length
    params.push(target.chainId, target.token, unixToIsoTimestamp(target.timestamp))
    return `($${offset + 1}::bigint, $${offset + 2}::varchar, $${offset + 3}::timestamptz)`
  })
  return { sql: values.join(', '), params }
}

function buildFinalizedValues(targets: RepairTarget[]): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = []
  const values = targets.map((target) => {
    const chain = chainIdToName(target.chainId)
    if (!chain) throw new Error(`Unsupported repair target chain: ${target.chainId}`)
    const offset = params.length
    params.push(target.chainId, chain, target.token, unixToIsoTimestamp(target.timestamp))
    return `($${offset + 1}::bigint, $${offset + 2}::varchar, $${offset + 3}::varchar, $${offset + 4}::timestamptz)`
  })
  return { sql: values.join(', '), params }
}

function rowToQueueItem(row: Record<string, unknown>): RepairQueueItem {
  return {
    chainId: Number(row.chain_id),
    token: String(row.token),
    timestamp: pgTimestampToUnix(row.timestamp as string | Date),
    attempts: Number(row.attempts),
    nextAttemptAt: pgTimestampToUnix(row.next_attempt_at as string | Date),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at == null ? null : pgTimestampToUnix(row.lease_expires_at as string | Date),
    lastOutcome: (row.last_outcome as RepairOutcome | null) ?? null,
    lastError: row.last_error == null ? null : String(row.last_error)
  }
}

function randomLeaseToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Returns keys that already have any accepted, finalized observation. */
export async function readFinalizedRepairKeys(
  db: RepairQueueDb,
  targets: RepairTarget[],
  now = Math.floor(Date.now() / 1_000)
): Promise<Set<string>> {
  const result = new Set<string>()
  if (targets.length === 0) return result
  const normalized = targets.map((target) => normalizeTarget(target, now))

  for (let offset = 0; offset < normalized.length; offset += MAX_QUEUE_KEYS_PER_QUERY) {
    const part = normalized.slice(offset, offset + MAX_QUEUE_KEYS_PER_QUERY)
    const values = buildFinalizedValues(part)
    const queryResult = await db.query<{ chain_id: number; token: string; timestamp: string | Date }>(
      `
        WITH requested(chain_id, chain, token, timestamp) AS (VALUES ${values.sql})
        SELECT r.chain_id, tp.token, tp.timestamp
        FROM token_prices tp
        INNER JOIN requested r
          ON tp.chain = r.chain
         AND lower(tp.token) = r.token
         AND tp.timestamp = r.timestamp
        WHERE tp.finalized = TRUE
          AND tp.price > 0
          AND tp.price::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND ${NOT_REJECTED_PRICE_SQL}
      `,
      values.params
    )
    for (const row of queryResult.rows)
      result.add(`${row.chain_id}:${String(row.token).toLowerCase()}:${pgTimestampToUnix(row.timestamp)}`)
  }
  return result
}

/** Enqueue only targets without a finalized accepted observation. */
export async function enqueueRepairTargets(
  db: RepairQueueDb,
  targets: RepairTarget[],
  now = Math.floor(Date.now() / 1_000)
): Promise<number> {
  const normalized = [
    ...new Map(
      targets.map((target) => {
        const value = normalizeTarget(target, now)
        return [targetKey(value), value]
      })
    ).values()
  ]
  if (normalized.length === 0) return 0
  const completed = await readFinalizedRepairKeys(db, normalized, now)
  const pending = normalized.filter((target) => !completed.has(targetKey(target)))
  if (pending.length === 0) return 0

  let affected = 0
  for (let offset = 0; offset < pending.length; offset += MAX_QUEUE_KEYS_PER_QUERY) {
    const part = pending.slice(offset, offset + MAX_QUEUE_KEYS_PER_QUERY)
    const values = buildTargetValues(part)
    const result = await db.query(
      `
        INSERT INTO historical_price_repair_queue (chain_id, token, "timestamp")
        VALUES ${values.sql}
        ON CONFLICT (token, "timestamp", chain_id) DO UPDATE SET
          completed_at = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.completed_at END,
          attempts = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN 0 ELSE historical_price_repair_queue.attempts END,
          next_attempt_at = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NOW() ELSE historical_price_repair_queue.next_attempt_at END,
          lease_owner = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.lease_owner END,
          lease_token = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.lease_token END,
          lease_expires_at = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.lease_expires_at END,
          last_outcome = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.last_outcome END,
          last_error = CASE WHEN historical_price_repair_queue.completed_at IS NOT NULL THEN NULL ELSE historical_price_repair_queue.last_error END,
          updated_at = NOW()
      `,
      values.params
    )
    affected += result.rowCount ?? part.length
  }
  return affected
}

export async function enqueueClosedRepairTargets(
  db: RepairQueueDb,
  targets: RepairTarget[],
  now = Math.floor(Date.now() / 1_000)
): Promise<number> {
  return enqueueRepairTargets(db, targets.filter((target) => isClosedDay(target.timestamp, now)), now)
}

/** Atomically claim due work. Expired leases are safely reclaimable. */
export async function claimRepairQueue(
  db: RepairQueueDb,
  options: { limit: number; owner: string; leaseSeconds: number; leaseToken?: string }
): Promise<RepairLease[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('repair queue limit must be positive')
  if (!Number.isFinite(options.leaseSeconds) || options.leaseSeconds <= 0) throw new Error('leaseSeconds must be positive')
  const token = options.leaseToken ?? randomLeaseToken()
  const result = await db.query<Record<string, unknown>>(
    `
      WITH due AS (
        SELECT chain_id, token, "timestamp"
        FROM historical_price_repair_queue
        WHERE completed_at IS NULL
          AND "timestamp" < to_timestamp(floor(extract(epoch FROM NOW()) / 86400)::bigint * 86400 + 86399)
          AND next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY next_attempt_at, updated_at, chain_id, token, "timestamp"
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE historical_price_repair_queue queue
      SET lease_owner = $2,
          lease_token = $3,
          lease_expires_at = NOW() + ($4::double precision * INTERVAL '1 second'),
          updated_at = NOW()
      FROM due
      WHERE queue.chain_id = due.chain_id AND queue.token = due.token AND queue."timestamp" = due."timestamp"
      RETURNING queue.*
    `,
    [options.limit, options.owner, token, options.leaseSeconds]
  )
  return result.rows.map((row) => ({ ...rowToQueueItem(row), leaseOwner: options.owner, leaseToken: token }))
}

export async function settleRepairSuccess(db: RepairQueueDb, lease: RepairLease): Promise<boolean> {
  const chain = chainIdToName(lease.chainId)
  if (!chain) return false
  const result = await db.query(
    `
      UPDATE historical_price_repair_queue
      SET completed_at = NOW(), lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_outcome = NULL, last_error = NULL, updated_at = NOW()
      WHERE chain_id = $1 AND token = $2 AND "timestamp" = $3::timestamptz
        AND completed_at IS NULL AND lease_owner = $4 AND lease_token = $5
        AND EXISTS (
          SELECT 1 FROM token_prices tp
          WHERE tp.chain = $6 AND lower(tp.token) = historical_price_repair_queue.token
            AND tp.timestamp = historical_price_repair_queue."timestamp"
            AND tp.finalized = TRUE
            AND tp.price > 0
            AND tp.price::text NOT IN ('NaN', 'Infinity', '-Infinity')
            AND ${NOT_REJECTED_PRICE_SQL}
        )
    `,
    [lease.chainId, lease.token, unixToIsoTimestamp(lease.timestamp), lease.leaseOwner, lease.leaseToken, chain]
  )
  return (result.rowCount ?? 0) === 1
}

export async function settleRepairFailure(
  db: RepairQueueDb,
  lease: RepairLease,
  outcome: RepairOutcome,
  error: string | null
): Promise<boolean> {
  if (!['missing', 'retryable', 'invalid'].includes(outcome)) throw new Error(`Invalid repair outcome: ${outcome}`)
  const delaySeconds = repairRetryDelaySeconds(outcome, lease.attempts)
  const result = await db.query(
    `
      UPDATE historical_price_repair_queue
      SET attempts = attempts + 1,
          next_attempt_at = NOW() + ($6::double precision * INTERVAL '1 second'),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_outcome = $4, last_error = $5, updated_at = NOW()
      WHERE chain_id = $1 AND token = $2 AND "timestamp" = $3::timestamptz
        AND completed_at IS NULL AND lease_owner = $7 AND lease_token = $8
    `,
    [lease.chainId, lease.token, unixToIsoTimestamp(lease.timestamp), outcome, error, delaySeconds, lease.leaseOwner, lease.leaseToken]
  )
  return (result.rowCount ?? 0) === 1
}

/** Return an owned claim to the due queue without charging an attempt. */
export async function releaseRepairLease(db: RepairQueueDb, lease: RepairLease): Promise<boolean> {
  const result = await db.query(
    `
      UPDATE historical_price_repair_queue
      SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
      WHERE chain_id = $1 AND token = $2 AND "timestamp" = $3::timestamptz
        AND completed_at IS NULL AND lease_owner = $4 AND lease_token = $5
    `,
    [lease.chainId, lease.token, unixToIsoTimestamp(lease.timestamp), lease.leaseOwner, lease.leaseToken]
  )
  return (result.rowCount ?? 0) === 1
}

