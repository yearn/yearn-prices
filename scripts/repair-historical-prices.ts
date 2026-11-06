import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { config } from 'dotenv'
import { parseManifest } from '../src/backfill/manifest'
import { createPool } from '../src/db'
import { discoverRepairTargets, finalizedRepairKeys } from './lib/historical-repair'
import {
  claimRepairQueue,
  enqueueRepairTargets,
  releaseRepairLease,
  settleRepairFailure,
  settleRepairSuccess,
  type RepairLease,
  type RepairQueueDb
} from '../src/db/repair-queue'
import { runGraphBackfill } from './lib/graph-backfill'
import { offlineProvider } from './lib/offline-provider'
import { fetchYearnVaults } from './lib/kong-vaults'

config({ quiet: true })

type TargetOutcomeRecord = {
  type?: string
  status?: string
  reason?: string | null
  target?: { chainId?: number; token?: string; eodTimestamp?: number }
}

function key(target: { chainId: number; token: string; timestamp: number }): string {
  return `${target.chainId}:${target.token.toLowerCase()}:${target.timestamp}`
}

export function classifyRepairFailure(record: TargetOutcomeRecord | undefined): 'missing' | 'retryable' | 'invalid' {
  if (!record || record.type !== 'target-outcome') return 'retryable'
  if (record.status === 'rejected' || record.status === 'rejected_implausible' || record.reason === 'invalid') return 'invalid'
  const reason = record.reason
  const value = (reason ?? '').toLowerCase()
  if (/cycle|max.?depth|budget|retryable|timeout|unavailable|provider|network|rate.?limit|malformed|transport|rpc/.test(value)) return 'retryable'
  if (/unsupported|not.?found|no price|no historical price/.test(value)) return 'missing'
  return 'retryable'
}

function readOutcomes(path: string): Map<string, TargetOutcomeRecord> {
  const outcomes = new Map<string, TargetOutcomeRecord>()
  if (!existsSync(path)) return outcomes
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const record = JSON.parse(line) as TargetOutcomeRecord
      const target = record.target
      if (record.type === 'target-outcome' && target?.chainId && target.token && target.eodTimestamp) {
        outcomes.set(key({ chainId: target.chainId, token: target.token, timestamp: target.eodTimestamp }), record)
      }
    } catch {
      // Evidence files are diagnostic; a malformed line must not make us settle a claim as successful.
    }
  }
  return outcomes
}

async function reconcile(db: RepairQueueDb, write: boolean, recentDays: number) {
  const vaults = await fetchYearnVaults()
  const roots = vaults
    .filter((vault) => !vault.isRetired && !vault.isHidden)
    .flatMap((vault) => [
      { chainId: vault.chainId, token: vault.vaultToken, timestamp: 1 },
      { chainId: vault.chainId, token: vault.underlyingToken, timestamp: 1 }
    ])
  const found = await discoverRepairTargets(db, roots, recentDays)
  const enqueued = write ? await enqueueRepairTargets(db, found.targets) : 0
  return { discovered: found.targets.length, finalized: found.finalized, enqueued, provisionalSelected: found.provisionalSelected, inventorySelected: found.inventorySelected, discoveryLimit: found.discoveryLimit }
}

async function processClaims(
  db: RepairQueueDb,
  claims: RepairLease[],
  options: { write: boolean; deadline: number; concurrency: number; providerRps: number; evidenceDir: string; signal: AbortSignal }
): Promise<{ completed: number; missing: number; errors: number; deferred: number }> {
  const metrics = { completed: 0, missing: 0, errors: 0, deferred: 0 }
  // A 429 is recorded on the queue and retried later. The shared limiter still
  // honors Retry-After, but this worker does not sleep past its lease/budget.
  const provider = offlineProvider(options.providerRps, { retryRateLimits: false, timeoutMs: 5_000, signal: options.signal })
  const groupSize = Math.max(1, Math.min(25, options.concurrency * 5))
  for (let offset = 0; offset < claims.length; offset += groupSize) {
    const group = claims.slice(offset, offset + groupSize)
    if (options.signal.aborted || Date.now() >= options.deadline) {
      for (const claim of group) {
        await releaseRepairLease(db, claim)
        metrics.deferred += 1
      }
      for (const claim of claims.slice(offset + groupSize)) {
        await releaseRepairLease(db, claim)
        metrics.deferred += 1
      }
      break
    }
    const evidence = join(options.evidenceDir, `${Date.now()}-${offset}.jsonl`)
    const manifest = parseManifest(JSON.stringify({
      version: 1,
      targets: group.map((claim) => ({ chainId: claim.chainId, token: claim.token, eodTimestamp: claim.timestamp }))
    }))
    let outcomes = new Map<string, TargetOutcomeRecord>()
    try {
      await runGraphBackfill({
        pool: db as ReturnType<typeof createPool>,
        manifest,
        out: evidence,
        write: options.write,
        concurrency: options.concurrency,
        providerRps: options.providerRps,
        provider,
        finalizedOnly: true,
        signal: options.signal
      })
      outcomes = readOutcomes(evidence)
    } catch (error) {
      outcomes = new Map(group.map((claim) => [key(claim), { reason: error instanceof Error ? error.message : String(error) }]))
    }
    const finalized = await finalizedRepairKeys(db, group)
    for (const claim of group) {
      if (!options.write) {
        await releaseRepairLease(db, claim)
        metrics.deferred += 1
        continue
      }
      if (finalized.has(key(claim))) {
        if (await settleRepairSuccess(db, claim)) metrics.completed += 1
        continue
      }
      const record = outcomes.get(key(claim))
      const outcome = classifyRepairFailure(record)
      if (await settleRepairFailure(db, claim, outcome, record?.reason ?? 'No finalized observation; retry classification')) {
        if (outcome === 'missing') metrics.missing += 1
        else metrics.errors += 1
      }
    }
  }
  return metrics
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args: argv,
    options: {
      reconcile: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      limit: { type: 'string', default: '100' },
      'recent-days': { type: 'string', default: '7' },
      'budget-seconds': { type: 'string', default: '600' },
      'lease-seconds': { type: 'string', default: '1800' },
      concurrency: { type: 'string', default: '2' },
      'provider-rps': { type: 'string', default: '1' },
      owner: { type: 'string', default: `historical-repair-${process.pid}` },
      out: { type: 'string' }
    }
  })

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const positiveInteger = (raw: string | undefined, label: string, maximum = Number.MAX_SAFE_INTEGER): number => {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be a positive safe integer`)
    return value
  }
  const limit = positiveInteger(values.limit, '--limit', 10_000)
  const recentDays = positiveInteger(values['recent-days'], '--recent-days', 365)
  const budgetSeconds = positiveInteger(values['budget-seconds'], '--budget-seconds', 86_400)
  const concurrency = positiveInteger(values.concurrency, '--concurrency', 32)
  const providerRps = positiveInteger(values['provider-rps'], '--provider-rps', 10)
  const leaseSeconds = positiveInteger(values['lease-seconds'], '--lease-seconds', 86_400)
  if (leaseSeconds < budgetSeconds + 300) throw new Error('--lease-seconds must exceed --budget-seconds by at least five minutes')
  const owner = values.owner!
  const outputDir = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), 'historical-repair-'))
  mkdirSync(outputDir, { recursive: true })
  const pool = createPool(databaseUrl)
  const started = Date.now()
  const controller = new AbortController()
  const deadlineTimer = setTimeout(() => controller.abort(new Error('Historical repair runtime budget exhausted')), budgetSeconds * 1000)
  // RPC/database drivers may not abort an already-running call. Stop the process
  // before its leases expire rather than let a timed-out worker overlap a reclaim.
  // Unsettled claims remain durable and recover through lease expiry.
  const hardStopTimer = setTimeout(() => {
    console.error(JSON.stringify({ message: 'repair-hard-deadline', durationMs: Date.now() - started, recovery: 'lease-expiry' }))
    process.exit(2)
  }, (budgetSeconds + 30) * 1000)
  try {
    const report: Record<string, unknown> = { startedAt: new Date(started).toISOString(), mode: values.write ? 'write' : 'dry-run', reconcile: values.reconcile }
    if (values.reconcile) report.reconcileResult = await reconcile(pool, values.write ?? false, recentDays)
    const dueBefore = Number(
      (await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM historical_price_repair_queue WHERE completed_at IS NULL AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now())`
      )).rows[0]?.count ?? 0
    )
    report.dueBefore = dueBefore
    if (values.write && !values.reconcile) {
      const claims = await claimRepairQueue(pool, { owner, limit, leaseSeconds })
      report.claimed = claims.length
      const result = await processClaims(pool, claims, {
        write: true,
        deadline: started + budgetSeconds * 1000,
        concurrency,
        providerRps,
        evidenceDir: outputDir,
        signal: controller.signal
      })
      report.workerResult = result
      if (result.errors > 0) process.exitCode = 1
    } else if (!values.reconcile) {
      report.claimed = 0
      report.workerResult = { completed: 0, missing: 0, errors: 0, deferred: dueBefore }
    }
    report.budgetExhausted = controller.signal.aborted
    if (controller.signal.aborted) process.exitCode = 1
    report.finishedAt = new Date().toISOString()
    report.durationMs = Date.now() - started
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    try {
      await pool.end()
    } finally {
      clearTimeout(deadlineTimer)
      clearTimeout(hardStopTimer)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
