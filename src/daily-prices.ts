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

export interface UnsupportedDailyPriceTargetInput extends DailyPriceTargetInput {
  failureReason: string
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

export interface DailyPriceRequeueFilter {
  chain: string
  eodTimestamp: number
  statuses?: Array<'unsupported' | 'quarantined'>
  failureClass?: DailyPriceFailureClass
  adapter?: string
  adapterVersion?: string
  policyVersion?: string
}

export type DailyPriceRequeueScope =
  | { targets: DailyPriceTargetInput[]; filter?: never }
  | { targets?: never; filter: DailyPriceRequeueFilter }

export interface DailyPriceRequeueRequest {
  requestedBy: string
  reason: string
  scope: DailyPriceRequeueScope
  nowTimestamp?: number
}

export interface DailyPriceRequeueResult {
  auditId: number
  requeued: number
  targets: Array<Pick<DailyPriceTarget, 'id' | 'chain' | 'token' | 'eodTimestamp'>>
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
const REQUEUE_LIMIT = 500

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

export async function reconcileDailyPriceTargetMetadata(
  pool: Pool,
  inputs: DailyPriceTargetInput[],
): Promise<number> {
  const unique = new Map<string, DailyPriceTargetInput>()
  for (const input of inputs) {
    const target = normalizeDailyPriceTarget(input)
    unique.set(`${target.chain}:${target.token}:${target.eodTimestamp}`, target)
  }

  let updated = 0
  for (const batch of chunk([...unique.values()], ENQUEUE_BATCH_SIZE)) {
    if (batch.length === 0) continue
    const valuesSql: string[] = []
    const params: Array<string | number> = []
    for (const target of batch) {
      const offset = params.length
      valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}::jsonb)`)
      params.push(
        target.chain,
        target.token,
        unixToIsoTimestamp(target.eodTimestamp),
        JSON.stringify(target.metadata ?? {}),
      )
    }
    const result = await pool.query<{ id: string | number }>(
      `
        WITH inventory(chain, token, eod_at, metadata) AS (
          VALUES ${valuesSql.join(', ')}
        )
        UPDATE daily_price_targets target
        SET
          metadata = COALESCE(target.metadata, '{}'::jsonb) || inventory.metadata,
          updated_at = NOW()
        FROM inventory
        WHERE target.chain = inventory.chain
          AND target.token = inventory.token
          AND target.eod_at = inventory.eod_at
          AND target.metadata IS DISTINCT FROM COALESCE(target.metadata, '{}'::jsonb) || inventory.metadata
        RETURNING target.id
      `,
      params,
    )
    updated += result.rows.length
  }
  return updated
}

export async function recordUnsupportedDailyPriceTargets(
  pool: Pool,
  inputs: UnsupportedDailyPriceTargetInput[],
): Promise<number> {
  const unique = new Map<string, UnsupportedDailyPriceTargetInput>()
  for (const input of inputs) {
    const chain = input.chain.trim().toLowerCase()
    if (!/^\d+$/.test(chain)) throw new Error(`Unsupported inventory chain must be a numeric chain id: ${input.chain}`)
    const token = normalizeTokenAddress(input.token)
    const eodTimestamp = normalizeToEndOfDay(input.eodTimestamp)
    if (eodTimestamp !== input.eodTimestamp || eodTimestamp > latestClosedUtcDayEnd(Math.floor(Date.now() / 1_000))) {
      throw new Error('Unsupported inventory targets must use an exact closed UTC EOD timestamp')
    }
    const failureReason = input.failureReason.trim()
    if (!failureReason) throw new Error('Unsupported inventory targets require a failure reason')
    unique.set(`${chain}:${token}:${eodTimestamp}`, {
      chain,
      token,
      eodTimestamp,
      failureReason,
      metadata: input.metadata && isRecord(input.metadata) ? input.metadata : {},
    })
  }

  let inserted = 0
  for (const batch of chunk([...unique.values()], ENQUEUE_BATCH_SIZE)) {
    if (batch.length === 0) continue
    const valuesSql: string[] = []
    const params: Array<string | number> = []
    for (const target of batch) {
      const offset = params.length
      valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, 'unsupported', 'unsupported', $${offset + 4}, NOW(), $${offset + 5}::jsonb)`)
      params.push(
        target.chain,
        target.token,
        unixToIsoTimestamp(target.eodTimestamp),
        target.failureReason,
        JSON.stringify(target.metadata ?? {}),
      )
    }
    const result = await pool.query<{ id: string | number }>(
      `
        INSERT INTO daily_price_targets (
          chain, token, eod_at, status, failure_class, failure_reason, completed_at, metadata
        )
        VALUES ${valuesSql.join(', ')}
        ON CONFLICT (chain, token, eod_at) DO UPDATE SET
          status = 'unsupported',
          failure_class = 'unsupported',
          failure_reason = EXCLUDED.failure_reason,
          next_retry_at = NULL,
          lease_expires_at = NULL,
          completed_at = COALESCE(daily_price_targets.completed_at, NOW()),
          metadata = COALESCE(daily_price_targets.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          updated_at = NOW()
        WHERE daily_price_targets.status <> 'priced'
          AND (
            daily_price_targets.status <> 'unsupported'
            OR daily_price_targets.failure_class IS DISTINCT FROM 'unsupported'
            OR daily_price_targets.failure_reason IS DISTINCT FROM EXCLUDED.failure_reason
            OR daily_price_targets.metadata IS DISTINCT FROM COALESCE(daily_price_targets.metadata, '{}'::jsonb) || EXCLUDED.metadata
          )
        RETURNING id
      `,
      params,
    )
    inserted += result.rows.length
  }
  return inserted
}

export async function getDailyPriceTargets(
  pool: Pool,
  inputs: DailyPriceTargetInput[],
): Promise<DailyPriceTarget[]> {
  if (inputs.length === 0) return []
  const unique = new Map<string, DailyPriceTargetInput>()
  for (const input of inputs) {
    const target = normalizeDailyPriceTarget(input)
    unique.set(`${target.chain}:${target.token}:${target.eodTimestamp}`, target)
  }
  const values: string[] = []
  const params: Array<string | number> = []
  for (const target of unique.values()) {
    const offset = params.length
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz)`)
    params.push(target.chain, target.token, unixToIsoTimestamp(target.eodTimestamp))
  }
  const result = await pool.query<DbDailyPriceTargetRow>(
    `
      WITH requested(chain, token, eod_at) AS (VALUES ${values.join(', ')})
      SELECT target.*
      FROM daily_price_targets target
      INNER JOIN requested
        ON target.chain = requested.chain
       AND target.token = requested.token
       AND target.eod_at = requested.eod_at
      ORDER BY target.chain, target.token
    `,
    params,
  )
  return result.rows.map(mapDailyPriceTarget)
}

function nonEmptyAuditText(value: string, name: string, maximum: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters`)
  }
  return normalized
}

function normalizeRequeueFilter(
  filter: DailyPriceRequeueFilter,
  nowTimestamp: number,
): DailyPriceRequeueFilter {
  const normalized = normalizeDailyPriceTarget({
    chain: filter.chain,
    token: '0x0000000000000000000000000000000000000000',
    eodTimestamp: filter.eodTimestamp,
  }, nowTimestamp)
  const statuses: Array<'unsupported' | 'quarantined'> = [
    ...new Set(filter.statuses ?? ['unsupported', 'quarantined'] as const),
  ]
  if (statuses.length === 0) throw new Error('Requeue filter statuses must not be empty')
  if (filter.failureClass && !['unsupported', 'retryable', 'invalid', 'disagreement'].includes(filter.failureClass)) {
    throw new Error('Requeue filter failureClass is invalid')
  }
  const optional = (value: string | undefined, name: string) => (
    value == null ? undefined : nonEmptyAuditText(value, name, 100)
  )
  return {
    chain: normalized.chain,
    eodTimestamp: normalized.eodTimestamp,
    statuses,
    failureClass: filter.failureClass,
    adapter: optional(filter.adapter, 'adapter'),
    adapterVersion: optional(filter.adapterVersion, 'adapterVersion'),
    policyVersion: optional(filter.policyVersion, 'policyVersion'),
  }
}

export async function requeueDailyPriceTargets(
  pool: Pool,
  request: DailyPriceRequeueRequest,
): Promise<DailyPriceRequeueResult> {
  const requestedBy = nonEmptyAuditText(request.requestedBy, 'requestedBy', 100)
  const reason = nonEmptyAuditText(request.reason, 'reason', 500)
  const nowTimestamp = request.nowTimestamp ?? Math.floor(Date.now() / 1_000)
  const targetInputs = request.scope.targets
  const filterInput = request.scope.filter
  const hasTargets = targetInputs != null
  const hasFilter = filterInput != null
  if (hasTargets === hasFilter) throw new Error('Requeue requires exactly one targets or filter scope')

  const params: Array<string | number | string[]> = []
  let selectorSql: string
  let normalizedScope: DailyPriceRequeueScope
  if (hasTargets) {
    const unique = new Map<string, DailyPriceTargetInput>()
    for (const input of targetInputs!) {
      const target = normalizeDailyPriceTarget(input, nowTimestamp)
      unique.set(`${target.chain}:${target.token}:${target.eodTimestamp}`, target)
    }
    const targets = [...unique.values()]
    if (targets.length === 0 || targets.length > REQUEUE_LIMIT) {
      throw new Error(`Requeue targets must contain between 1 and ${REQUEUE_LIMIT} unique entries`)
    }
    const values = targets.map(target => {
      const offset = params.length
      params.push(target.chain, target.token, unixToIsoTimestamp(target.eodTimestamp))
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz)`
    })
    selectorSql = `
      INNER JOIN (VALUES ${values.join(', ')}) AS requested(chain, token, eod_at)
        ON target.chain = requested.chain
       AND target.token = requested.token
       AND target.eod_at = requested.eod_at
    `
    normalizedScope = { targets }
  } else {
    const filter = normalizeRequeueFilter(filterInput!, nowTimestamp)
    params.push(filter.chain, unixToIsoTimestamp(filter.eodTimestamp), filter.statuses!)
    selectorSql = `
      WHERE target.chain = $1
        AND target.eod_at = $2::timestamptz
        AND target.status = ANY($3::text[])
    `
    if (filter.failureClass) {
      params.push(filter.failureClass)
      selectorSql += ` AND target.failure_class = $${params.length}`
    }
    if (filter.adapter) {
      params.push(filter.adapter)
      selectorSql += ` AND target.adapter = $${params.length}`
    }
    if (filter.adapterVersion) {
      params.push(filter.adapterVersion)
      selectorSql += ` AND target.metadata->>'adapterVersion' = $${params.length}`
    }
    if (filter.policyVersion) {
      params.push(filter.policyVersion)
      selectorSql += ` AND target.metadata->>'policyVersion' = $${params.length}`
    }
    normalizedScope = { filter }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query<DbDailyPriceTargetRow>(
      `
        SELECT target.*
        FROM daily_price_targets target
        ${selectorSql}
        ${hasTargets ? "WHERE target.status IN ('unsupported', 'quarantined')" : ''}
        ORDER BY target.chain, target.eod_at, target.token
        LIMIT ${REQUEUE_LIMIT + 1}
        FOR UPDATE OF target
      `,
      params,
    )
    if (selected.rows.length > REQUEUE_LIMIT) {
      throw new Error(`Requeue scope matches more than ${REQUEUE_LIMIT} targets`)
    }

    const priorTargets = selected.rows.map(row => ({
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
    }))
    const audit = await client.query<{ id: string | number }>(
      `
        INSERT INTO daily_price_requeue_audits (
          requested_by, reason, scope, targets, target_count
        ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
        RETURNING id
      `,
      [requestedBy, reason, JSON.stringify(normalizedScope), JSON.stringify(priorTargets), priorTargets.length],
    )
    const auditId = Number(audit.rows[0]?.id)
    if (!Number.isSafeInteger(auditId) || auditId <= 0) throw new Error('Requeue audit insert did not return an id')

    if (priorTargets.length > 0) {
      const ids = priorTargets.map(target => target.id)
      await client.query(
        `
          UPDATE daily_price_targets
          SET
            status = 'pending',
            attempt_count = 0,
            adapter = NULL,
            failure_class = NULL,
            failure_reason = NULL,
            next_retry_at = NULL,
            lease_expires_at = NULL,
            last_attempt_at = NULL,
            completed_at = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'lastRequeue', jsonb_build_object(
                'auditId', $2::bigint,
                'requestedBy', $3::text,
                'reason', $4::text,
                'requeuedAt', $5::timestamptz
              )
            ),
            updated_at = NOW()
          WHERE id = ANY($1::bigint[])
        `,
        [ids, auditId, requestedBy, reason, unixToIsoTimestamp(nowTimestamp)],
      )
    }
    await client.query('COMMIT')
    return {
      auditId,
      requeued: priorTargets.length,
      targets: priorTargets.map(({ id, chain, token, eodTimestamp }) => ({ id, chain, token, eodTimestamp })),
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function markDailyPriceTargetsPriced(
  pool: Pool,
  inputs: DailyPriceTargetInput[],
  adapter: string,
): Promise<number> {
  if (inputs.length === 0) return 0
  const unique = new Map<string, DailyPriceTargetInput>()
  for (const input of inputs) {
    const target = normalizeDailyPriceTarget(input)
    unique.set(`${target.chain}:${target.token}:${target.eodTimestamp}`, target)
  }

  let updated = 0
  for (const batch of chunk([...unique.values()], ENQUEUE_BATCH_SIZE)) {
    const values: string[] = []
    const params: Array<string | number> = []
    for (const target of batch) {
      const offset = params.length
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}::jsonb)`)
      params.push(
        target.chain,
        target.token,
        unixToIsoTimestamp(target.eodTimestamp),
        JSON.stringify(target.metadata ?? {}),
      )
    }
    params.push(adapter)
    const adapterIndex = params.length
    const result = await pool.query<{ id: string | number }>(
      `
        WITH accepted(chain, token, eod_at, metadata) AS (VALUES ${values.join(', ')})
        UPDATE daily_price_targets target
        SET
          status = 'priced',
          adapter = $${adapterIndex},
          failure_class = NULL,
          failure_reason = NULL,
          next_retry_at = NULL,
          lease_expires_at = NULL,
          completed_at = COALESCE(target.completed_at, NOW()),
          metadata = COALESCE(target.metadata, '{}'::jsonb) || accepted.metadata,
          updated_at = NOW()
        FROM accepted
        WHERE target.chain = accepted.chain
          AND target.token = accepted.token
          AND target.eod_at = accepted.eod_at
          AND target.status IN ('pending', 'retryable', 'unsupported')
        RETURNING target.id
      `,
      params,
    )
    updated += result.rows.length
  }
  return updated
}

export async function claimDailyPriceTargets(
  pool: Pool,
  limit: number,
  options: { nowTimestamp?: number; leaseSeconds?: number; maxAttempts?: number } = {},
): Promise<DailyPriceTarget[]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('DailyPrice claim limit must be a positive integer')
  const nowTimestamp = options.nowTimestamp ?? Math.floor(Date.now() / 1_000)
  const leaseSeconds = options.leaseSeconds ?? 300
  const maxAttempts = options.maxAttempts ?? 3
  if (!Number.isSafeInteger(nowTimestamp) || nowTimestamp < 0) throw new Error('nowTimestamp must be a unix timestamp')
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error('leaseSeconds must be a positive integer')
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error('maxAttempts must be a positive integer')

  const result = await pool.query<DbDailyPriceTargetRow>(
    `
      WITH exhausted AS (
        UPDATE daily_price_targets
        SET
          status = 'quarantined',
          failure_class = 'retryable',
          next_retry_at = NULL,
          lease_expires_at = NULL,
          completed_at = COALESCE(completed_at, $2::timestamptz),
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'retryExhausted', jsonb_build_object(
              'attemptCount', attempt_count,
              'maxAttempts', $4::integer,
              'originalFailureClass', 'retryable',
              'exhaustedAt', $2::timestamptz
            )
          ),
          updated_at = NOW()
        WHERE status = 'retryable'
          AND attempt_count >= $4
        RETURNING id
      ),
      eligible AS (
        SELECT id
        FROM daily_price_targets
        WHERE status = 'pending'
          OR (
            status = 'retryable'
            AND attempt_count < $4
            AND (next_retry_at IS NULL OR next_retry_at <= $2::timestamptz)
          )
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
    [limit, unixToIsoTimestamp(nowTimestamp), leaseSeconds, maxAttempts],
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

export async function getNextDailyPriceRetryTimestamp(pool: Pool, maxAttempts: number): Promise<number | null> {
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error('maxAttempts must be a positive integer')
  const result = await pool.query<{ next_retry_at: string | Date | null }>(
    `
      SELECT MIN(next_retry_at) AS next_retry_at
      FROM daily_price_targets
      WHERE status = 'retryable'
        AND attempt_count < $1
    `,
    [maxAttempts],
  )
  return result.rows[0]?.next_retry_at ? pgTimestampToUnix(result.rows[0].next_retry_at) : null
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
