import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE } from './cache'
import { jsonResponse } from './http'
import { pgTimestampToUnix, unixToIsoTimestamp } from './time'

type DailyPriceRunState = 'idle' | 'queued' | 'running' | 'waiting_retry' | 'stalled' | 'complete'

interface SummaryRow {
  started_at: string | Date | null
  last_activity_at: string | Date | null
  total: string | number
  attempted: string | number
  pending: string | number
  in_progress: string | number
  priced: string | number
  unsupported: string | number
  retryable: string | number
  quarantined: string | number
  active_leases: string | number
  expired_leases: string | number
  completed_1m: string | number
  completed_5m: string | number
  completed_15m: string | number
}

interface ChainRow {
  chain: string
  total: string | number
  pending: string | number
  in_progress: string | number
  priced: string | number
  unsupported: string | number
  retryable: string | number
  quarantined: string | number
}

interface AdapterRow {
  adapter: string
  count: string | number
}

interface FailureRow {
  status: string
  failure_class: string
  resolution_failure: string | null
  count: string | number
}

interface TargetRow {
  chain: string
  token: string
  eod_at: string | Date
  status: string
  adapter: string | null
  failure_class: string | null
  resolution_failure: string | null
  failure_reason?: string | null
  last_attempt_at?: string | Date | null
  lease_expires_at?: string | Date | null
  updated_at?: string | Date | null
}

export interface DailyPriceProgressSnapshot {
  generatedAt: number
  state: DailyPriceRunState
  queue: {
    total: number
    attempted: number
    resolved: number
    remaining: number
    pending: number
    inProgress: number
    priced: number
    unsupported: number
    retryable: number
    quarantined: number
    activeLeases: number
    expiredLeases: number
    completionPercent: number
  }
  activity: {
    startedAt: number | null
    lastActivityAt: number | null
    ratePerMinute: {
      oneMinute: number
      fiveMinutes: number
      fifteenMinutes: number
    }
    etaSeconds: number | null
  }
  chains: Array<DailyPriceProgressSnapshot['queue'] & { chain: string }>
  adapters: Array<{ adapter: string; count: number; pricedPercent: number }>
  sources: Array<{ source: string; count: number; pricedPercent: number }>
  qualities: Array<{ quality: string; count: number; pricedPercent: number }>
  failures: Array<{
    status: string
    failureClass: string
    resolutionFailure: string | null
    count: number
  }>
  active: Array<{
    chain: string
    token: string
    eodAt: number
    lastAttemptAt: number | null
    leaseExpiresAt: number | null
  }>
  recent: Array<{
    chain: string
    token: string
    eodAt: number
    status: string
    adapter: string | null
    failureClass: string | null
    resolutionFailure: string | null
    failureReason: string | null
    updatedAt: number | null
  }>
}

const TERMINAL_STATUSES = "('priced', 'unsupported', 'quarantined')"

function numberValue(value: string | number | null | undefined): number {
  return Number(value ?? 0)
}

function timestampValue(value: string | Date | null | undefined): number | null {
  return value == null ? null : pgTimestampToUnix(value)
}

function queueFromRow(row: Omit<ChainRow, 'chain'> & Partial<Pick<SummaryRow, 'attempted' | 'active_leases' | 'expired_leases'>>) {
  const total = numberValue(row.total)
  const pending = numberValue(row.pending)
  const inProgress = numberValue(row.in_progress)
  const priced = numberValue(row.priced)
  const unsupported = numberValue(row.unsupported)
  const retryable = numberValue(row.retryable)
  const quarantined = numberValue(row.quarantined)
  const resolved = priced + unsupported + quarantined
  return {
    total,
    attempted: numberValue(row.attempted),
    resolved,
    remaining: pending + inProgress + retryable,
    pending,
    inProgress,
    priced,
    unsupported,
    retryable,
    quarantined,
    activeLeases: numberValue(row.active_leases),
    expiredLeases: numberValue(row.expired_leases),
    completionPercent: total === 0 ? 0 : (resolved / total) * 100,
  }
}

function inferRunState(
  queue: DailyPriceProgressSnapshot['queue'],
  lastActivityAt: number | null,
  nowTimestamp: number,
): DailyPriceRunState {
  if (queue.total === 0) return 'idle'
  if (queue.remaining === 0) return 'complete'
  if (queue.attempted === 0) return 'queued'
  if (lastActivityAt !== null && nowTimestamp - lastActivityAt <= 120) return 'running'
  if (queue.pending === 0 && queue.inProgress === 0 && queue.retryable > 0) return 'waiting_retry'
  return 'stalled'
}

function safeResolutionFailure(value: string | null): string | null {
  return value && ['unsupported', 'retryable', 'invalid', 'disagreement', 'cycle', 'max-depth'].includes(value)
    ? value
    : null
}

export function sanitizeFailureReason(value: string | null | undefined): string | null {
  if (!value) return null
  return value
    .replace(/https?:\/\/[^\s;]+/gi, '<redacted-url>')
    .replace(/(api[_-]?key|token|secret)=([^\s&;]+)/gi, '$1=<redacted>')
    .slice(0, 1_000)
}

export async function getDailyPriceProgressSnapshot(
  pool: Pool,
  nowTimestamp = Math.floor(Date.now() / 1_000),
): Promise<DailyPriceProgressSnapshot> {
  const now = unixToIsoTimestamp(nowTimestamp)
  const [
    summaryResult,
    chainsResult,
    adaptersResult,
    sourcesResult,
    qualitiesResult,
    failuresResult,
    activeResult,
    recentResult,
  ] = await Promise.all([
    pool.query<SummaryRow>(`
      SELECT
        MIN(last_attempt_at) FILTER (WHERE attempt_count > 0) AS started_at,
        MAX(updated_at) FILTER (WHERE attempt_count > 0) AS last_activity_at,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE attempt_count > 0) AS attempted,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'priced') AS priced,
        COUNT(*) FILTER (WHERE status = 'unsupported') AS unsupported,
        COUNT(*) FILTER (WHERE status = 'retryable') AS retryable,
        COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined,
        COUNT(*) FILTER (WHERE status = 'in_progress' AND lease_expires_at > $1::timestamptz) AS active_leases,
        COUNT(*) FILTER (WHERE status = 'in_progress' AND lease_expires_at <= $1::timestamptz) AS expired_leases,
        COUNT(*) FILTER (WHERE status IN ${TERMINAL_STATUSES} AND completed_at >= $1::timestamptz - INTERVAL '1 minute') AS completed_1m,
        COUNT(*) FILTER (WHERE status IN ${TERMINAL_STATUSES} AND completed_at >= $1::timestamptz - INTERVAL '5 minutes') AS completed_5m,
        COUNT(*) FILTER (WHERE status IN ${TERMINAL_STATUSES} AND completed_at >= $1::timestamptz - INTERVAL '15 minutes') AS completed_15m
      FROM daily_price_targets
    `, [now]),
    pool.query<ChainRow>(`
      SELECT
        chain,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'priced') AS priced,
        COUNT(*) FILTER (WHERE status = 'unsupported') AS unsupported,
        COUNT(*) FILTER (WHERE status = 'retryable') AS retryable,
        COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined
      FROM daily_price_targets
      GROUP BY chain
      ORDER BY chain
    `),
    pool.query<AdapterRow>(`
      SELECT adapter, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced' AND adapter IS NOT NULL
      GROUP BY adapter
      ORDER BY count DESC, adapter
    `),
    pool.query<AdapterRow>(`
      SELECT COALESCE(metadata->>'source', 'unknown') AS adapter, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY COALESCE(metadata->>'source', 'unknown')
      ORDER BY count DESC, adapter
    `),
    pool.query<AdapterRow>(`
      SELECT COALESCE(metadata->>'quality', 'unknown') AS adapter, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY COALESCE(metadata->>'quality', 'unknown')
      ORDER BY count DESC, adapter
    `),
    pool.query<FailureRow>(`
      SELECT
        status,
        failure_class,
        CASE
          WHEN metadata->>'resolutionFailure' IN ('unsupported', 'retryable', 'invalid', 'disagreement', 'cycle', 'max-depth')
            THEN metadata->>'resolutionFailure'
          ELSE NULL
        END AS resolution_failure,
        COUNT(*) AS count
      FROM daily_price_targets
      WHERE failure_class IS NOT NULL
      GROUP BY status, failure_class, resolution_failure
      ORDER BY count DESC, status, failure_class
      LIMIT 12
    `),
    pool.query<TargetRow>(`
      SELECT chain, token, eod_at, status, last_attempt_at, lease_expires_at
      FROM daily_price_targets
      WHERE status = 'in_progress' AND lease_expires_at > $1::timestamptz
      ORDER BY last_attempt_at DESC, chain, eod_at, token
      LIMIT 10
    `, [now]),
    pool.query<TargetRow>(`
      SELECT
        chain,
        token,
        eod_at,
        status,
        adapter,
        failure_class,
        failure_reason,
        CASE
          WHEN metadata->>'resolutionFailure' IN ('unsupported', 'retryable', 'invalid', 'disagreement', 'cycle', 'max-depth')
            THEN metadata->>'resolutionFailure'
          ELSE NULL
        END AS resolution_failure,
        updated_at
      FROM daily_price_targets
      WHERE status IN ('priced', 'unsupported', 'retryable', 'quarantined')
      ORDER BY updated_at DESC, id DESC
      LIMIT 12
    `),
  ])

  const summary = summaryResult.rows[0] ?? {
    started_at: null,
    last_activity_at: null,
    total: 0,
    attempted: 0,
    pending: 0,
    in_progress: 0,
    priced: 0,
    unsupported: 0,
    retryable: 0,
    quarantined: 0,
    active_leases: 0,
    expired_leases: 0,
    completed_1m: 0,
    completed_5m: 0,
    completed_15m: 0,
  }
  const queue = queueFromRow(summary)
  const lastActivityAt = timestampValue(summary.last_activity_at)
  const fiveMinuteRate = numberValue(summary.completed_5m) / 5

  return {
    generatedAt: nowTimestamp,
    state: inferRunState(queue, lastActivityAt, nowTimestamp),
    queue,
    activity: {
      startedAt: timestampValue(summary.started_at),
      lastActivityAt,
      ratePerMinute: {
        oneMinute: numberValue(summary.completed_1m),
        fiveMinutes: fiveMinuteRate,
        fifteenMinutes: numberValue(summary.completed_15m) / 15,
      },
      etaSeconds: fiveMinuteRate > 0 ? Math.round((queue.remaining / fiveMinuteRate) * 60) : null,
    },
    chains: chainsResult.rows.map(row => ({ chain: row.chain, ...queueFromRow(row) })),
    adapters: adaptersResult.rows.map(row => ({
      adapter: row.adapter,
      count: numberValue(row.count),
      pricedPercent: queue.priced === 0 ? 0 : (numberValue(row.count) / queue.priced) * 100,
    })),
    sources: sourcesResult.rows.map(row => ({
      source: row.adapter,
      count: numberValue(row.count),
      pricedPercent: queue.priced === 0 ? 0 : (numberValue(row.count) / queue.priced) * 100,
    })),
    qualities: qualitiesResult.rows.map(row => ({
      quality: row.adapter,
      count: numberValue(row.count),
      pricedPercent: queue.priced === 0 ? 0 : (numberValue(row.count) / queue.priced) * 100,
    })),
    failures: failuresResult.rows.map(row => ({
      status: row.status,
      failureClass: row.failure_class,
      resolutionFailure: safeResolutionFailure(row.resolution_failure),
      count: numberValue(row.count),
    })),
    active: activeResult.rows.map(row => ({
      chain: row.chain,
      token: row.token,
      eodAt: pgTimestampToUnix(row.eod_at),
      lastAttemptAt: timestampValue(row.last_attempt_at),
      leaseExpiresAt: timestampValue(row.lease_expires_at),
    })),
    recent: recentResult.rows.map(row => ({
      chain: row.chain,
      token: row.token,
      eodAt: pgTimestampToUnix(row.eod_at),
      status: row.status,
      adapter: row.adapter,
      failureClass: row.failure_class,
      resolutionFailure: safeResolutionFailure(row.resolution_failure),
      failureReason: sanitizeFailureReason(row.failure_reason),
      updatedAt: timestampValue(row.updated_at),
    })),
  }
}

export async function handleDailyPriceProgress(pool: Pool): Promise<Response> {
  return jsonResponse(await getDailyPriceProgressSnapshot(pool), {
    headers: { 'cache-control': CACHE_CONTROL_NO_STORE },
  })
}
