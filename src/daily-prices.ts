import type { Pool } from '@neondatabase/serverless'
import { normalizeTokenAddress, SUPPORTED_CHAIN_NAMES } from './chains'
import { latestClosedUtcDayEnd, normalizeToEndOfDay, pgTimestampToUnix, unixToIsoTimestamp } from './time'

export type DailyPriceTargetStatus =
  | 'pending'
  | 'in_progress'
  | 'priced'
  | 'unsupported'
  | 'retryable'
  | 'quarantined'

export type DailyPriceFailureClass = 'unsupported' | 'retryable' | 'invalid' | 'disagreement'

export interface DailyPriceTargetInput {
  chain: string
  token: string
  eodTimestamp: number
  metadata?: Record<string, unknown>
}

interface DbDailyPriceTargetRow {
  id: string | number | bigint
  chain: string
  token: string
  eod_at: string | Date
  status: DailyPriceTargetStatus
  attempt_count: string | number
  adapter: string | null
  failure_class: DailyPriceFailureClass | null
  failure_reason: string | null
  metadata: unknown
}

export interface DailyPriceTarget {
  id: number
  chain: string
  token: string
  eodTimestamp: number
  status: DailyPriceTargetStatus
  attemptCount: number
  adapter: string | null
  failureClass: DailyPriceFailureClass | null
  failureReason: string | null
  metadata: Record<string, unknown>
}

export type DailyPriceOutcome =
  | { status: 'priced'; adapter: string; metadata?: Record<string, unknown> }
  | { status: 'unsupported'; adapter?: string | null; failureReason: string; metadata?: Record<string, unknown> }
  | {
      status: 'retryable'
      adapter?: string | null
      failureReason: string
      nextRetryTimestamp: number
      metadata?: Record<string, unknown>
    }
  | {
      status: 'quarantined'
      adapter?: string | null
      failureClass: 'invalid' | 'disagreement'
      failureReason: string
      metadata?: Record<string, unknown>
    }

export interface DailyPriceOutcomeRecord {
  targetId: number
  attemptCount: number
  outcome: DailyPriceOutcome
}

interface DbDailyPriceProgressRow {
  started_at: string | Date | null
  total: string | number
  attempted: string | number
  pending: string | number
  in_progress: string | number
  priced: string | number
  unsupported: string | number
  retryable: string | number
  quarantined: string | number
}

export interface DailyPriceProgress {
  startedTimestamp: number | null
  total: number
  attempted: number
  remaining: number
  pending: number
  inProgress: number
  priced: number
  unsupported: number
  retryable: number
  quarantined: number
  adapterCounts: Record<string, number>
}

export interface DailyPriceProgressSnapshot extends DailyPriceProgress {
  current: Pick<DailyPriceTarget, 'chain' | 'token' | 'eodTimestamp'> | null
  elapsedSeconds: number
  processingRate: number
}

const ENQUEUE_BATCH_SIZE = 500

export function normalizeDailyPriceTarget(
  target: DailyPriceTargetInput,
  nowTimestamp = Math.floor(Date.now() / 1_000),
): DailyPriceTargetInput {
  const chain = target.chain.toLowerCase()
  if (!SUPPORTED_CHAIN_NAMES.has(chain)) throw new Error(`Unsupported chain: ${target.chain}`)
  if (!Number.isSafeInteger(target.eodTimestamp) || target.eodTimestamp < 0) {
    throw new Error('eodTimestamp must be a non-negative unix timestamp')
  }
  const eodTimestamp = normalizeToEndOfDay(target.eodTimestamp)
  if (eodTimestamp > latestClosedUtcDayEnd(nowTimestamp)) {
    throw new Error('Daily price targets must be for a closed UTC day')
  }
  return {
    chain,
    token: normalizeTokenAddress(target.token),
    eodTimestamp,
    metadata: target.metadata && isRecord(target.metadata) ? target.metadata : {},
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

export async function enqueueDailyPriceTargets(
  pool: Pool,
  targets: DailyPriceTargetInput[],
  options: { nowTimestamp?: number } = {},
): Promise<number> {
  const unique = new Map<string, DailyPriceTargetInput>()
  for (const input of targets) {
    const target = normalizeDailyPriceTarget(input, options.nowTimestamp)
    unique.set(`${target.chain}:${target.token}:${target.eodTimestamp}`, target)
  }

  let inserted = 0
  for (const batch of chunk([...unique.values()], ENQUEUE_BATCH_SIZE)) {
    if (batch.length === 0) continue
    const valuesSql: string[] = []
    const params: Array<string | number | null> = []
    for (const target of batch) {
      const offset = params.length
      valuesSql.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}::jsonb)`,
      )
      params.push(
        target.chain,
        target.token,
        unixToIsoTimestamp(target.eodTimestamp),
        JSON.stringify(target.metadata ?? {}),
      )
    }
    const result = await pool.query<{ id: string | number }>(
      `
        INSERT INTO daily_price_targets (chain, token, eod_at, metadata)
        VALUES ${valuesSql.join(', ')}
        ON CONFLICT (chain, token, eod_at) DO NOTHING
        RETURNING id
      `,
      params,
    )
    inserted += result.rows.length
  }
  return inserted
}

export async function claimDailyPriceTargets(
  pool: Pool,
  limit: number,
  options: { nowTimestamp?: number; leaseSeconds?: number } = {},
): Promise<DailyPriceTarget[]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('DailyPrice claim limit must be a positive integer')
  const nowTimestamp = options.nowTimestamp ?? Math.floor(Date.now() / 1_000)
  const leaseSeconds = options.leaseSeconds ?? 300
  if (!Number.isSafeInteger(nowTimestamp) || nowTimestamp < 0) throw new Error('nowTimestamp must be a unix timestamp')
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error('leaseSeconds must be a positive integer')

  const result = await pool.query<DbDailyPriceTargetRow>(
    `
      WITH eligible AS (
        SELECT id
        FROM daily_price_targets
        WHERE status = 'pending'
          OR (status = 'retryable' AND (next_retry_at IS NULL OR next_retry_at <= $2::timestamptz))
          OR (status = 'in_progress' AND lease_expires_at <= $2::timestamptz)
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'retryable' THEN 1 ELSE 2 END,
          chain,
          eod_at,
          token
        FOR UPDATE SKIP LOCKED
        LIMIT $1
      )
      UPDATE daily_price_targets target
      SET
        status = 'in_progress',
        attempt_count = target.attempt_count + 1,
        last_attempt_at = $2::timestamptz,
        lease_expires_at = $2::timestamptz + ($3::integer * INTERVAL '1 second'),
        next_retry_at = NULL,
        updated_at = NOW()
      FROM eligible
      WHERE target.id = eligible.id
      RETURNING target.*
    `,
    [limit, unixToIsoTimestamp(nowTimestamp), leaseSeconds],
  )
  return result.rows.map(mapDailyPriceTarget)
}

export async function recordDailyPriceOutcome(
  pool: Pool,
  targetId: number,
  attemptCount: number,
  outcome: DailyPriceOutcome,
): Promise<void> {
  const normalized = normalizeOutcomeRecord({ targetId, attemptCount, outcome })

  const result = await pool.query<{ id: string | number }>(
    `
      UPDATE daily_price_targets
      SET
        status = $3,
        adapter = $4,
        failure_class = $5,
        failure_reason = $6,
        next_retry_at = $7::timestamptz,
        lease_expires_at = NULL,
        completed_at = $8::timestamptz,
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($9::jsonb, '{}'::jsonb),
        updated_at = NOW()
      WHERE id = $1 AND attempt_count = $2 AND status = 'in_progress'
      RETURNING id
    `,
    normalized,
  )
  if (result.rows.length !== 1) {
    throw new Error(`DailyPrice target ${targetId} attempt ${attemptCount} is not currently leased`)
  }
}

const OUTCOME_BATCH_SIZE = 500

function normalizeOutcomeRecord(record: DailyPriceOutcomeRecord): Array<string | number | null> {
  const { targetId, attemptCount, outcome } = record
  if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new Error('targetId must be a positive integer')
  if (!Number.isSafeInteger(attemptCount) || attemptCount <= 0) {
    throw new Error('attemptCount must be a positive integer')
  }

  const failureClass: DailyPriceFailureClass | null = outcome.status === 'priced'
    ? null
    : outcome.status === 'unsupported'
      ? 'unsupported'
      : outcome.status === 'retryable'
        ? 'retryable'
        : outcome.failureClass
  const failureReason = outcome.status === 'priced' ? null : outcome.failureReason
  if (outcome.status === 'retryable'
    && (!Number.isSafeInteger(outcome.nextRetryTimestamp) || outcome.nextRetryTimestamp < 0)) {
    throw new Error('nextRetryTimestamp must be a non-negative unix timestamp')
  }
  const nextRetryAt = outcome.status === 'retryable' ? unixToIsoTimestamp(outcome.nextRetryTimestamp) : null
  const completed = outcome.status === 'retryable' ? null : new Date().toISOString()
  return [
    targetId,
    attemptCount,
    outcome.status,
    outcome.adapter ?? null,
    failureClass,
    failureReason,
    nextRetryAt,
    completed,
    outcome.metadata ? JSON.stringify(outcome.metadata) : null,
  ]
}

export async function recordDailyPriceOutcomes(pool: Pool, records: DailyPriceOutcomeRecord[]): Promise<void> {
  const uniqueIds = new Set(records.map(record => record.targetId))
  if (uniqueIds.size !== records.length) throw new Error('DailyPrice outcome target ids must be unique')

  for (const batch of chunk(records, OUTCOME_BATCH_SIZE)) {
    if (batch.length === 0) continue
    const params: Array<string | number | null> = []
    const values = batch.map(record => {
      const offset = params.length
      params.push(...normalizeOutcomeRecord(record))
      return `($${offset + 1}::bigint, $${offset + 2}::integer, $${offset + 3}::text, $${offset + 4}::text, `
        + `$${offset + 5}::text, $${offset + 6}::text, $${offset + 7}::timestamptz, `
        + `$${offset + 8}::timestamptz, $${offset + 9}::jsonb)`
    })
    const result = await pool.query<{ id: string | number }>(
      `
        WITH outcomes(
          id, attempt_count, status, adapter, failure_class, failure_reason, next_retry_at, completed_at, metadata
        ) AS (
          VALUES ${values.join(', ')}
        ),
        eligible_outcomes AS (
          SELECT outcomes.*
          FROM outcomes
          INNER JOIN daily_price_targets target
            ON target.id = outcomes.id
           AND target.attempt_count = outcomes.attempt_count
           AND target.status = 'in_progress'
        ),
        complete_batch AS (
          SELECT 1
          FROM eligible_outcomes
          HAVING COUNT(*) = ${batch.length}
        )
        UPDATE daily_price_targets target
        SET
          status = eligible_outcomes.status,
          adapter = eligible_outcomes.adapter,
          failure_class = eligible_outcomes.failure_class,
          failure_reason = eligible_outcomes.failure_reason,
          next_retry_at = eligible_outcomes.next_retry_at,
          lease_expires_at = NULL,
          completed_at = eligible_outcomes.completed_at,
          metadata = COALESCE(target.metadata, '{}'::jsonb) || COALESCE(eligible_outcomes.metadata, '{}'::jsonb),
          updated_at = NOW()
        FROM eligible_outcomes, complete_batch
        WHERE target.id = eligible_outcomes.id
        RETURNING target.id
      `,
      params,
    )
    if (result.rows.length !== batch.length) {
      throw new Error(`DailyPrice outcome batch updated ${result.rows.length} of ${batch.length} leased targets`)
    }
  }
}

export async function getDailyPriceProgress(pool: Pool): Promise<DailyPriceProgress> {
  const [progressResult, adaptersResult] = await Promise.all([
    pool.query<DbDailyPriceProgressRow>(`
      SELECT
        MIN(created_at) AS started_at,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE attempt_count > 0) AS attempted,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'priced') AS priced,
        COUNT(*) FILTER (WHERE status = 'unsupported') AS unsupported,
        COUNT(*) FILTER (WHERE status = 'retryable') AS retryable,
        COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined
      FROM daily_price_targets
    `),
    pool.query<{ adapter: string; count: string | number }>(`
      SELECT adapter, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced' AND adapter IS NOT NULL
      GROUP BY adapter
      ORDER BY count DESC, adapter
    `),
  ])
  const row = progressResult.rows[0]
  const pending = Number(row?.pending ?? 0)
  const inProgress = Number(row?.in_progress ?? 0)
  const retryable = Number(row?.retryable ?? 0)
  return {
    startedTimestamp: row?.started_at ? pgTimestampToUnix(row.started_at) : null,
    total: Number(row?.total ?? 0),
    attempted: Number(row?.attempted ?? 0),
    remaining: pending + inProgress + retryable,
    pending,
    inProgress,
    priced: Number(row?.priced ?? 0),
    unsupported: Number(row?.unsupported ?? 0),
    retryable,
    quarantined: Number(row?.quarantined ?? 0),
    adapterCounts: Object.fromEntries(adaptersResult.rows.map(row => [row.adapter, Number(row.count)])),
  }
}

export function buildDailyPriceProgressSnapshot(
  progress: DailyPriceProgress,
  current: DailyPriceProgressSnapshot['current'],
  nowTimestamp = Math.floor(Date.now() / 1_000),
): DailyPriceProgressSnapshot {
  const elapsedSeconds = Math.max(
    progress.startedTimestamp == null ? 0 : nowTimestamp - progress.startedTimestamp,
    0,
  )
  return {
    ...progress,
    current,
    elapsedSeconds,
    processingRate: elapsedSeconds === 0 ? 0 : progress.attempted / elapsedSeconds,
  }
}

function mapDailyPriceTarget(row: DbDailyPriceTargetRow): DailyPriceTarget {
  return {
    id: Number(row.id),
    chain: row.chain,
    token: row.token,
    eodTimestamp: pgTimestampToUnix(row.eod_at),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    adapter: row.adapter,
    failureClass: row.failure_class,
    failureReason: row.failure_reason,
    metadata: isRecord(row.metadata) ? row.metadata : {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
