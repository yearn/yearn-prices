import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'

loadEnv()

import { applicableAlias } from '../src/backfill/alias-eligibility'
import { parseCliArgs } from '../src/backfill/args'
import { readChartCoin } from '../src/backfill/chart-envelope'
import {
  CHART_REQUEST_TIMEOUT_MS,
  CHART_RETRY_AFTER_CAP_MS,
  EXACT_READ_CHUNK_SIZE,
  FINALIZATION_BATCH_SIZE,
  MAXIMUM_ACCEPTED_OFFSET_SECONDS,
  MAXIMUM_CHART_SPAN_DAYS,
  PROVIDER_SEARCH_WIDTH
} from '../src/backfill/constants'
import { httpAttempts, httpDiagnosticCodes } from '../src/backfill/diagnostics'
import {
  type BackfillClientPool,
  FinalizationLockError,
  type FinalizationTarget,
  type FinalizationTargetResult,
  finalizeBackfillTargets
} from '../src/backfill/finalize'
import { deleteInventoryRows } from '../src/backfill/inventory'
import { ManifestError, manifestDigest, type NormalizedTarget, parseManifest } from '../src/backfill/manifest'
import { matchChartObservation } from '../src/backfill/matcher'
import { priceKey, readPricedKeys } from '../src/backfill/priced-keys'
import { gitRevision, toolVersion } from '../src/backfill/provenance'
import { type ContiguousRange, groupContiguousRanges, rangeSpanDays } from '../src/backfill/ranges'
import { DefiLlamaClient, SlidingWindowRateLimiter } from '../src/clients'
import { HttpRequestError } from '../src/clients/http-client'
import { createPool } from '../src/db'
import { listDefiLlamaCoinGeckoAliases } from '../src/sources/defillama/aliases'
import { chunk } from '../src/utils'

export type TargetStatus = 'pending' | 'skipped_existing' | 'inserted' | 'skipped_concurrent_existing' | 'unresolved'

export type TargetMethod = 'defillama-direct' | 'defillama-alias'

export interface TargetMethodRecord {
  method: TargetMethod
  providerIdentifier: string
  attempts: number
  diagnosticCodes: string[]
}

export interface TargetRecord {
  chainId: number
  chain: string
  token: string
  eodTimestamp: number
  status: TargetStatus
  method: string | null
  providerIdentifier: string | null
  observedTimestamp: number | null
  offsetSeconds: number | null
  price: number | null
  source: string | null
  attempts: number
  diagnosticCodes: string[]
  methods: TargetMethodRecord[]
  projected?: boolean
}

export interface BackfillReport {
  toolVersion: string
  codeRevision: string | null
  mode: 'dry-run' | 'write'
  startedAt: string
  finishedAt: string | null
  manifest: { path: string; digest: string; byteLength: number }
  aliasRegistryDigest: string
  searchWidth: string
  maximumAcceptedOffsetSeconds: number
  request: { chartRequests: number; retries: number; requestFailures: number; rateLimitedResponses: number }
  summary: Record<string, number>
  targets: TargetRecord[]
  fatal?: { message: string; committedTargets: number; failedTargets: number; unattemptedTargets: number }
}

export interface BackfillPool extends BackfillClientPool {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface ChartFetchResult {
  coin: unknown
  attempts: number
  malformed?: boolean
  rateLimited?: number
}

export type ChartFetch = (identifier: string, rangeStart: number, spanDays: number) => Promise<ChartFetchResult>

export interface BackfillDeps {
  pool: BackfillPool
  fetchChart: ChartFetch
}

export interface BackfillOptions {
  manifestPath: string
  reportPath: string
  write: boolean
  maximumOffsetSeconds?: number
  maximumChartSpanDays?: number
  batchSize?: number
  readChunkSize?: number
  now?: number
}

export interface BackfillRunResult {
  exitCode: 0 | 1 | 2
  report: BackfillReport
}

export class ChartRequestError extends Error {
  readonly attempts: number
  readonly diagnosticCodes: string[]
  readonly rateLimited: number

  constructor(attempts: number, diagnosticCodes: string[], cause?: unknown, rateLimited = 0) {
    super(`DeFiLlama chart request failed after ${attempts} attempts`)
    this.name = 'ChartRequestError'
    this.attempts = attempts
    this.diagnosticCodes = diagnosticCodes
    this.rateLimited = rateLimited
    this.cause = cause
  }
}

export class PreflightError extends Error {
  readonly rows: Array<{ chain: string; token: string }>

  constructor(rows: Array<{ chain: string; token: string }>) {
    super(
      `token_prices holds ${rows.length} noncanonical token casings for manifest targets: ${rows
        .slice(0, 5)
        .map((row) => `${row.chain}:${row.token}`)
        .join(', ')}`
    )
    this.name = 'PreflightError'
    this.rows = rows
  }
}

type TargetRange = ContiguousRange<NormalizedTarget>

function targetKey(target: { chain: string; token: string; eodTimestamp: number }): string {
  return priceKey(target.chain, target.token, target.eodTimestamp)
}

function writeAtomically(path: string, payload: object): void {
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

export function writeReport(reportPath: string, report: BackfillReport): void {
  writeAtomically(reportPath, report)
}

export async function preflightTokenCasings(
  pool: BackfillPool,
  targets: NormalizedTarget[],
  readChunkSize: number
): Promise<void> {
  const triples = new Map<string, [string, string, string]>()
  for (const target of targets) {
    triples.set(`${target.chain}:${target.tokenLowercase}`, [target.chain, target.tokenLowercase, target.token])
  }

  const offending: Array<{ chain: string; token: string }> = []
  for (const triplesChunk of chunk([...triples.values()], readChunkSize)) {
    const valuesSql: string[] = []
    const params: string[] = []
    for (const [chain, tokenLowercase, canonical] of triplesChunk) {
      const offset = params.length
      valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`)
      params.push(chain, tokenLowercase, canonical)
    }

    const result = await pool.query(
      `
        SELECT DISTINCT tp.chain, tp.token
        FROM token_prices tp
        INNER JOIN (VALUES ${valuesSql.join(', ')}) AS requested(chain, token_lower, token_canonical)
          ON tp.chain = requested.chain
         AND lower(tp.token) = requested.token_lower
        WHERE tp.token <> requested.token_canonical
      `,
      params
    )

    for (const row of result.rows) {
      offending.push({ chain: row.chain as string, token: row.token as string })
    }
  }

  if (offending.length > 0) {
    throw new PreflightError(offending)
  }
}

interface RunState {
  records: Map<string, TargetRecord>
  chartRequests: number
  retries: number
  requestFailures: number
  retryExhaustedFailures: number
  rateLimitedResponses: number
  invalidProviderResponses: number
  resolvedDirect: number
  resolvedAlias: number
  lockRetries: number
  lockFailures: number
  lockWaitMs: number
  lockHoldMs: number
}

function newRecord(target: NormalizedTarget, status: TargetStatus): TargetRecord {
  return {
    chainId: target.chainId,
    chain: target.chain,
    token: target.token,
    eodTimestamp: target.eodTimestamp,
    status,
    method: null,
    providerIdentifier: null,
    observedTimestamp: null,
    offsetSeconds: null,
    price: null,
    source: null,
    attempts: 0,
    diagnosticCodes: [],
    methods: []
  }
}

function methodRecord(record: TargetRecord, method: TargetMethod, providerIdentifier: string): TargetMethodRecord {
  const existing = record.methods.find(
    (entry) => entry.method === method && entry.providerIdentifier === providerIdentifier
  )
  if (existing) {
    return existing
  }
  const created: TargetMethodRecord = { method, providerIdentifier, attempts: 0, diagnosticCodes: [] }
  record.methods.push(created)
  return created
}

function chartDiagnosticCodes(error: unknown): string[] {
  if (error instanceof ChartRequestError) {
    return error.diagnosticCodes
  }
  return httpDiagnosticCodes(error)
}

function chartAttempts(error: unknown): number {
  if (error instanceof ChartRequestError) {
    return error.attempts
  }
  return httpAttempts(error)
}

async function resolveRanges(
  ranges: TargetRange[],
  method: TargetMethod,
  fetchChart: ChartFetch,
  state: RunState,
  options: {
    maximumOffsetSeconds: number
    eligibility?: (target: NormalizedTarget) => (observedTimestamp: number) => boolean
  }
): Promise<Map<string, { price: number; symbol: string | null; confidence: number | null }>> {
  const resolved = new Map<string, { price: number; symbol: string | null; confidence: number | null }>()

  for (const range of ranges) {
    const spanDays = rangeSpanDays(range)
    state.chartRequests += 1

    let fetched: ChartFetchResult
    try {
      fetched = await fetchChart(range.identifier, range.rangeStart, spanDays)
    } catch (error) {
      state.requestFailures += 1
      const codes = chartDiagnosticCodes(error)
      const attempts = chartAttempts(error)
      if (codes.includes('retry_exhausted')) {
        state.retryExhaustedFailures += 1
      }
      if (error instanceof ChartRequestError) {
        state.rateLimitedResponses += error.rateLimited
      }
      state.retries += Math.max(attempts - 1, 0)
      for (const target of range.items) {
        const record = state.records.get(targetKey(target)) as TargetRecord
        const entry = methodRecord(record, method, range.identifier)
        record.attempts += attempts
        entry.attempts += attempts
        record.diagnosticCodes.push(...codes)
        entry.diagnosticCodes.push(...codes)
        record.providerIdentifier = range.identifier
      }
      continue
    }

    state.retries += Math.max(fetched.attempts - 1, 0)
    state.rateLimitedResponses += fetched.rateLimited ?? 0
    let invalidResponse = false

    for (const target of range.items) {
      const record = state.records.get(targetKey(target)) as TargetRecord
      const entry = methodRecord(record, method, range.identifier)
      record.attempts += fetched.attempts
      entry.attempts += fetched.attempts

      const matched = fetched.malformed
        ? ({ kind: 'invalid_response' } as const)
        : matchChartObservation(fetched.coin, target.eodTimestamp, {
            maximumOffsetSeconds: options.maximumOffsetSeconds,
            isEligibleObservation: options.eligibility?.(target)
          })

      if (matched.kind === 'matched') {
        record.method = method
        record.providerIdentifier = range.identifier
        record.observedTimestamp = matched.observedTimestamp
        record.offsetSeconds = matched.offsetSeconds
        record.price = matched.price
        record.source = 'defillama'
        resolved.set(targetKey(target), {
          price: matched.price,
          symbol: matched.symbol,
          confidence: matched.confidence
        })
        if (method === 'defillama-alias') {
          state.resolvedAlias += 1
        } else {
          state.resolvedDirect += 1
        }
        continue
      }

      record.providerIdentifier = range.identifier
      record.diagnosticCodes.push(matched.kind)
      entry.diagnosticCodes.push(matched.kind)
      if (matched.kind === 'invalid_response') {
        invalidResponse = true
      }
    }

    if (invalidResponse) {
      state.invalidProviderResponses += 1
    }
  }

  return resolved
}

export async function runBackfill(options: BackfillOptions, deps: BackfillDeps): Promise<BackfillRunResult> {
  const maximumOffsetSeconds = options.maximumOffsetSeconds ?? MAXIMUM_ACCEPTED_OFFSET_SECONDS
  const maximumChartSpanDays = options.maximumChartSpanDays ?? MAXIMUM_CHART_SPAN_DAYS
  const batchSize = options.batchSize ?? FINALIZATION_BATCH_SIZE
  const readChunkSize = options.readChunkSize ?? EXACT_READ_CHUNK_SIZE
  const startedAt = new Date().toISOString()

  const state: RunState = {
    records: new Map(),
    chartRequests: 0,
    retries: 0,
    requestFailures: 0,
    retryExhaustedFailures: 0,
    rateLimitedResponses: 0,
    invalidProviderResponses: 0,
    resolvedDirect: 0,
    resolvedAlias: 0,
    lockRetries: 0,
    lockFailures: 0,
    lockWaitMs: 0,
    lockHoldMs: 0
  }

  const report: BackfillReport = {
    toolVersion: toolVersion(),
    codeRevision: gitRevision(),
    mode: options.write ? 'write' : 'dry-run',
    startedAt,
    finishedAt: null,
    manifest: { path: options.manifestPath, digest: '', byteLength: 0 },
    aliasRegistryDigest: manifestDigest(JSON.stringify(listDefiLlamaCoinGeckoAliases())),
    searchWidth: PROVIDER_SEARCH_WIDTH,
    maximumAcceptedOffsetSeconds: maximumOffsetSeconds,
    request: { chartRequests: 0, retries: 0, requestFailures: 0, rateLimitedResponses: 0 },
    summary: {},
    targets: []
  }

  let requestedCount = 0
  let duplicateCount = 0
  let alreadyPriced = 0
  let committedTargets = 0
  let inFlightBatch = 0
  let finalizationTargets: FinalizationTarget[] = []

  try {
    const manifestBytes = readFileSync(options.manifestPath)
    const manifest = parseManifest(manifestBytes, { now: options.now })
    report.manifest = { path: options.manifestPath, digest: manifest.digest, byteLength: manifest.byteLength }
    requestedCount = manifest.requestedCount
    duplicateCount = manifest.duplicateCount

    for (const target of manifest.targets) {
      state.records.set(targetKey(target), newRecord(target, 'pending'))
    }

    await preflightTokenCasings(deps.pool, manifest.targets, readChunkSize)

    const priced = await readPricedKeys(deps.pool, manifest.targets, readChunkSize)
    const skippedExisting: NormalizedTarget[] = []
    const gapTargets: NormalizedTarget[] = []
    for (const target of manifest.targets) {
      if (priced.has(targetKey(target))) {
        const record = state.records.get(targetKey(target)) as TargetRecord
        record.status = 'skipped_existing'
        skippedExisting.push(target)
        continue
      }
      gapTargets.push(target)
    }
    alreadyPriced = skippedExisting.length

    if (options.write && skippedExisting.length > 0) {
      await deleteInventoryRows(
        deps.pool,
        skippedExisting.map((target) => ({
          chainId: target.chainId,
          tokenLowercase: target.tokenLowercase,
          eodTimestamp: target.eodTimestamp
        }))
      )
    }

    const directRanges = groupContiguousRanges(
      gapTargets,
      (target) => `${target.chain}:${target.tokenLowercase}`,
      (target) => target.eodTimestamp,
      maximumChartSpanDays
    )
    const directResolved = await resolveRanges(directRanges, 'defillama-direct', deps.fetchChart, state, {
      maximumOffsetSeconds
    })

    const aliasTargets: NormalizedTarget[] = []
    const aliasByKey = new Map<string, NonNullable<ReturnType<typeof applicableAlias>>>()
    for (const target of gapTargets) {
      if (directResolved.has(targetKey(target))) {
        continue
      }
      const alias = applicableAlias(target)
      if (!alias) {
        const record = state.records.get(targetKey(target)) as TargetRecord
        record.diagnosticCodes.push('not_applicable')
        continue
      }
      aliasByKey.set(targetKey(target), alias)
      aliasTargets.push(target)
    }

    const aliasRanges = groupContiguousRanges(
      aliasTargets,
      (target) => aliasByKey.get(targetKey(target))!.identifier,
      (target) => target.eodTimestamp,
      maximumChartSpanDays
    )
    const aliasResolved = await resolveRanges(aliasRanges, 'defillama-alias', deps.fetchChart, state, {
      maximumOffsetSeconds,
      eligibility: (target) => aliasByKey.get(targetKey(target))!.isEligibleObservation
    })

    finalizationTargets = gapTargets.map((target) => {
      const key = targetKey(target)
      const match = directResolved.get(key) ?? aliasResolved.get(key)
      const resolution = match ? { ...match, source: 'defillama' as const } : null

      return {
        chainId: target.chainId,
        chain: target.chain,
        token: target.token,
        tokenLowercase: target.tokenLowercase,
        eodTimestamp: target.eodTimestamp,
        resolution
      }
    })

    await finalizeBackfillTargets(deps.pool, finalizationTargets, {
      dryRun: !options.write,
      batchSize,
      readChunkSize,
      onBatchStart: (size) => {
        inFlightBatch = size
      },
      onBatchSettled: ({ batch, results, lockRetries, lockWaitMs, lockHoldMs }) => {
        inFlightBatch = 0
        state.lockRetries += lockRetries
        state.lockWaitMs += lockWaitMs
        state.lockHoldMs += lockHoldMs
        applyFinalizationResults(state, results, options.write)
        committedTargets += batch.length
      }
    })

    applyReportState(report, state, { requestedCount, duplicateCount, alreadyPriced, write: options.write }, true)
    writeReport(options.reportPath, report)

    const unresolved = report.summary.unresolved
    return { exitCode: unresolved > 0 ? 2 : 0, report }
  } catch (error) {
    if (error instanceof FinalizationLockError) {
      state.lockFailures += 1
      state.lockRetries += error.attempts - 1
    }
    applyReportState(report, state, { requestedCount, duplicateCount, alreadyPriced, write: options.write }, false)
    const planned =
      finalizationTargets.length > 0 ? finalizationTargets.length : Math.max(state.records.size - alreadyPriced, 0)
    report.fatal = {
      message: error instanceof Error ? error.message : String(error),
      committedTargets,
      failedTargets: inFlightBatch,
      unattemptedTargets: Math.max(planned - committedTargets - inFlightBatch, 0)
    }
    writeReport(options.reportPath, report)
    return { exitCode: 1, report }
  }
}

function applyFinalizationResults(state: RunState, results: FinalizationTargetResult[], write: boolean): void {
  for (const result of results) {
    const record = state.records.get(priceKey(result.chain, result.token, result.eodTimestamp)) as TargetRecord
    record.status = result.status
    if (result.status === 'inserted' && !write) {
      record.projected = true
    }
  }
}

interface ReportCounts {
  requestedCount: number
  duplicateCount: number
  alreadyPriced: number
  write: boolean
}

interface RunSummary {
  requested: number
  normalizedUniqueTargets: number
  duplicateManifestTargets: number
  alreadyPriced: number
  resolvedByDirectProvider: number
  resolvedByReviewedAlias: number
  skippedConcurrentExisting: number
  unresolved: number
  pending: number
  providerRetryFailures: number
  rateLimitedResponses: number
  invalidProviderResponses: number
  finalizationLockFailures: number
  finalizationLockRetries: number
  finalizationLockWaitMs: number
  finalizationLockHoldMs: number
  inserted: number
  projectedInserted: number
}

function applyReportState(
  report: BackfillReport,
  state: RunState,
  counts: ReportCounts,
  resolvePending: boolean
): void {
  if (resolvePending) {
    for (const record of state.records.values()) {
      if (record.status === 'pending') {
        record.status = 'unresolved'
      }
    }
  }

  const targets = [...state.records.values()]
  const insertedRecords = targets.filter((record) => record.status === 'inserted')
  const projected = insertedRecords.filter((record) => record.projected === true).length

  report.finishedAt = new Date().toISOString()
  report.request = {
    chartRequests: state.chartRequests,
    retries: state.retries,
    requestFailures: state.requestFailures,
    rateLimitedResponses: state.rateLimitedResponses
  }
  report.targets = targets
  report.summary = {
    requested: counts.requestedCount,
    normalizedUniqueTargets: targets.length,
    duplicateManifestTargets: counts.duplicateCount,
    alreadyPriced: counts.alreadyPriced,
    resolvedByDirectProvider: state.resolvedDirect,
    resolvedByReviewedAlias: state.resolvedAlias,
    skippedConcurrentExisting: targets.filter((record) => record.status === 'skipped_concurrent_existing').length,
    unresolved: targets.filter((record) => record.status === 'unresolved').length,
    pending: targets.filter((record) => record.status === 'pending').length,
    providerRetryFailures: state.retryExhaustedFailures,
    rateLimitedResponses: state.rateLimitedResponses,
    invalidProviderResponses: state.invalidProviderResponses,
    finalizationLockFailures: state.lockFailures,
    finalizationLockRetries: state.lockRetries,
    finalizationLockWaitMs: state.lockWaitMs,
    finalizationLockHoldMs: state.lockHoldMs,
    inserted: counts.write ? insertedRecords.length : 0,
    projectedInserted: counts.write ? 0 : projected
  } satisfies RunSummary
}

export function createChartFetcher(searchWidth: string): ChartFetch {
  const rateLimiter = new SlidingWindowRateLimiter(10, 1000)

  return async (identifier, rangeStart, spanDays) => {
    let retries = 0
    let rateLimited = 0
    const client = new DefiLlamaClient(
      rateLimiter,
      (_attempt, _delayMs, _url, status) => {
        retries += 1
        if (status === 429) {
          rateLimited += 1
        }
      },
      {
        timeoutMs: CHART_REQUEST_TIMEOUT_MS,
        honorRetryAfter: true,
        retryAfterCapMs: CHART_RETRY_AFTER_CAP_MS,
        retryRateLimits: true,
        retryTransportErrors: true,
        retryInvalidJson: true
      }
    )

    try {
      const response = await client.getChart([identifier], {
        start: rangeStart,
        span: spanDays,
        period: '1d',
        searchWidth
      })
      const envelope = readChartCoin(response, identifier)
      return {
        coin: envelope.kind === 'coin' ? envelope.coin : undefined,
        attempts: 1 + retries,
        malformed: envelope.kind === 'invalid',
        rateLimited
      }
    } catch (error) {
      const terminalRateLimit = error instanceof HttpRequestError && error.responseStatus === 429 ? 1 : 0
      throw new ChartRequestError(1 + retries, chartDiagnosticCodes(error), error, rateLimited + terminalRateLimit)
    }
  }
}

interface Args {
  manifestPath: string
  reportPath: string
  write: boolean
  databaseUrlEnv?: string
}

const KNOWN_OPTIONS = new Set(['--manifest', '--report', '--database-url-env'])
const KNOWN_FLAGS = new Set(['--write', '--dry-run'])

export function parseArgs(argv: string[]): Args {
  const { options, flags } = parseCliArgs(argv, { options: KNOWN_OPTIONS, flags: KNOWN_FLAGS })

  const manifestPath = options.get('--manifest')
  const reportPath = options.get('--report')
  if (!manifestPath || !reportPath) {
    throw new Error('--manifest and --report are required')
  }
  if (flags.has('--write') && flags.has('--dry-run')) {
    throw new Error('--write and --dry-run are mutually exclusive')
  }

  return {
    manifestPath,
    reportPath,
    write: flags.has('--write'),
    databaseUrlEnv: options.get('--database-url-env')
  }
}

async function main(argv: string[]): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }

  const databaseUrlEnv = args.databaseUrlEnv ?? 'DATABASE_URL'
  const databaseUrl = process.env[databaseUrlEnv]
  if (!databaseUrl) {
    console.error(
      `a database URL is required: set ${databaseUrlEnv} in the environment (name another variable with --database-url-env)`
    )
    return 1
  }

  const pool = createPool(databaseUrl)
  try {
    const result = await runBackfill(
      { manifestPath: args.manifestPath, reportPath: args.reportPath, write: args.write },
      { pool: pool as unknown as BackfillPool, fetchChart: createChartFetcher(PROVIDER_SEARCH_WIDTH) }
    )
    console.info(
      JSON.stringify({
        message: 'backfill-complete',
        mode: result.report.mode,
        report: args.reportPath,
        exitCode: result.exitCode,
        ...result.report.summary
      })
    )
    if (result.report.fatal) {
      console.error(result.report.fatal.message)
    }
    return result.exitCode
  } catch (error) {
    console.error(error instanceof ManifestError ? error.issues.join('; ') : (error as Error).message)
    return 1
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)))
}
