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
/** An invalid target is parked after this many attempts until an operator clears last_outcome. */
export const MAX_INVALID_ATTEMPTS = 3
const REOPENABLE_SQL = `historical_price_repair_queue.completed_at IS NOT NULL AND historical_price_repair_queue.last_outcome IS DISTINCT FROM 'invalid'`

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

/** Diagnostic states for exact audit gaps; never includes provider URLs or raw errors. */
export async function readRepairTargetStates(db: RepairQueueDb, targets: RepairTarget[]) {
  const states: Record<string, unknown>[] = []
  const normalized = targets.map((target) => normalizeTarget(target, Math.floor(Date.now() / 1000)))
  for (let offset = 0; offset < normalized.length; offset += MAX_QUEUE_KEYS_PER_QUERY) {
    const values = buildTargetValues(normalized.slice(offset, offset + MAX_QUEUE_KEYS_PER_QUERY))
    const result = await db.query<Record<string, unknown>>(
      `WITH requested(chain_id, token, timestamp) AS (VALUES ${values.sql})
       SELECT r.chain_id, r.token, r.timestamp, q.attempts, q.last_outcome, q.next_attempt_at,
         CASE WHEN q.token IS NULL THEN 'not-queued'
           WHEN q.completed_at IS NOT NULL THEN 'parked-or-completed'
           WHEN q.lease_expires_at > NOW() THEN 'leased'
           WHEN q.next_attempt_at > NOW() THEN 'cooldown'
           ELSE 'due' END AS state
       FROM requested r LEFT JOIN historical_price_repair_queue q
         ON q.chain_id = r.chain_id AND q.token = r.token AND q.timestamp = r.timestamp`,
      values.params
    )
    states.push(...result.rows)
  }
  return states
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
          completed_at = NULL, attempts = 0, next_attempt_at = NOW(),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_outcome = NULL, last_error = NULL, updated_at = NOW()
        WHERE ${REOPENABLE_SQL}
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
  return enqueueRepairTargets(
    db,
    targets.filter((target) => isClosedDay(target.timestamp, now)),
    now
  )
}

/** Atomically claim due work. Expired leases are safely reclaimable. */
export async function claimRepairQueue(
  db: RepairQueueDb,
  options: {
    limit: number
    owner: string
    leaseSeconds: number
    leaseToken?: string
    recentDays?: number
    recentOnly?: boolean
    targets?: RepairTarget[]
  }
): Promise<RepairLease[]> {
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('repair queue limit must be positive')
  if (!Number.isFinite(options.leaseSeconds) || options.leaseSeconds <= 0)
    throw new Error('leaseSeconds must be positive')
  const recentDays = options.recentDays ?? 7
  if (!Number.isSafeInteger(recentDays) || recentDays < 1 || recentDays > 365)
    throw new Error('recentDays must be an integer from 1 through 365')
  if (options.targets?.length === 0) return []
  const requested = options.targets?.map((target) => normalizeTarget(target, Math.floor(Date.now() / 1000)))
  const token = options.leaseToken ?? randomLeaseToken()
  const result = await db.query<Record<string, unknown>>(
    `
      WITH due AS (
        SELECT chain_id, token, "timestamp"
        FROM historical_price_repair_queue
        WHERE completed_at IS NULL
          AND ($7::jsonb IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_to_recordset($7::jsonb) AS requested(chain_id bigint, token text, timestamp timestamptz)
            WHERE requested.chain_id = historical_price_repair_queue.chain_id
              AND requested.token = historical_price_repair_queue.token
              AND requested.timestamp = historical_price_repair_queue.timestamp
          ))
          AND "timestamp" < to_timestamp(floor(extract(epoch FROM NOW()) / 86400)::bigint * 86400 + 86399)
          AND next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
          AND (NOT $6::boolean OR "timestamp" >= to_timestamp(
            floor(extract(epoch FROM NOW()) / 86400)::bigint * 86400 - $5::bigint * 86400))
        ORDER BY ("timestamp" >= to_timestamp(
          floor(extract(epoch FROM NOW()) / 86400)::bigint * 86400 - $5::bigint * 86400)) DESC,
          next_attempt_at, updated_at, chain_id, token, "timestamp"
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
    [
      options.limit,
      options.owner,
      token,
      options.leaseSeconds,
      recentDays,
      options.recentOnly ?? false,
      requested
        ? JSON.stringify(
            requested.map((target) => ({
              chain_id: target.chainId,
              token: target.token,
              timestamp: unixToIsoTimestamp(target.timestamp)
            }))
          )
        : null
    ]
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
  const parked = outcome === 'invalid' && lease.attempts + 1 >= MAX_INVALID_ATTEMPTS
  const result = await db.query(
    `
      UPDATE historical_price_repair_queue
      SET attempts = attempts + 1,
          next_attempt_at = NOW() + ($6::double precision * INTERVAL '1 second'),
          completed_at = CASE WHEN $9::boolean THEN NOW() ELSE NULL END,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_outcome = $4, last_error = $5, updated_at = NOW()
      WHERE chain_id = $1 AND token = $2 AND "timestamp" = $3::timestamptz
        AND completed_at IS NULL AND lease_owner = $7 AND lease_token = $8
    `,
    [
      lease.chainId,
      lease.token,
      unixToIsoTimestamp(lease.timestamp),
      outcome,
      error,
      delaySeconds,
      lease.leaseOwner,
      lease.leaseToken,
      parked
    ]
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
