import type { Pool } from '@neondatabase/serverless'
import {
  buildDailyPriceProgressSnapshot,
  claimDailyPriceTargets,
  getDailyPriceProgress,
  recordDailyPriceOutcome,
  recordDailyPriceOutcomes,
  type DailyPriceOutcome,
  type DailyPriceProgressSnapshot,
  type DailyPriceTarget,
} from './daily-prices'
import { insertTokenPrices } from './queries'
import {
  isRetryablePricingError,
  type RecursivePriceResult,
  type ResolvedPricePath,
} from './recursive-pricing'

export interface DailyPriceResolver {
  prefetch?(targets: Array<{
    chain: string
    token: string
    requestedTimestamp: number
    blockNumber: number | null
  }>): Promise<void>
  resolve(target: {
    chain: string
    token: string
    requestedTimestamp: number
    blockNumber: number | null
  }): Promise<RecursivePriceResult>
}

export interface DailyPriceTargetProcessorOptions {
  retryDelaySeconds?: number
  nowTimestamp?: number
}

export interface DailyPriceWorkerOptions extends DailyPriceTargetProcessorOptions {
  batchSize?: number
  concurrency?: number
  leaseSeconds?: number
  maxAttempts?: number
  maxTargets?: number
  progressEvery?: number
  onProgress?: (progress: DailyPriceProgressSnapshot) => void
}

export interface DailyPriceWorkerSummary {
  processed: number
  claimedBatches: number
  progress: DailyPriceProgressSnapshot
}

export interface DailyPriceTargetProcessorDependencies {
  insertPrices?: typeof insertTokenPrices
  recordOutcome?: typeof recordDailyPriceOutcome
}

export interface DailyPriceWorkerDependencies extends DailyPriceTargetProcessorDependencies {
  validateConfiguration?: () => Promise<void>
  claimTargets?: typeof claimDailyPriceTargets
  loadProgress?: typeof getDailyPriceProgress
  recordOutcomes?: typeof recordDailyPriceOutcomes
}

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_CONCURRENCY = 1
const DEFAULT_LEASE_SECONDS = 300
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_SECONDS = 5 * 60
const DEFAULT_PROGRESS_EVERY = 25

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

async function mapConcurrentResults<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await worker(values[index])
      }
    },
  ))
  return results
}

function pathToWrite(path: ResolvedPricePath) {
  return {
    chain: path.chain,
    token: path.token,
    timestamp: path.requestedTimestamp,
    price: path.priceUsd,
    symbol: path.symbol,
    confidence: path.confidence,
    source: path.source,
    observedTimestamp: path.observedTimestamp,
    classification: path.classification,
    quality: path.quality,
    adapter: path.adapter,
    blockNumber: path.blockNumber,
    inputs: path.inputs,
    validationStatus: 'validated' as const,
    metadata: path.metadata,
  }
}

interface ResolvedDailyPriceTarget {
  outcome: DailyPriceOutcome
  price: ReturnType<typeof pathToWrite> | null
}

function failureReason(result: Extract<RecursivePriceResult, { path: null }>): string {
  if (result.failure.attempts.length === 0) {
    return result.failure.reason === 'unsupported'
      ? 'No historical market price or recursive adapter supports the target'
      : `Recursive resolution failed: ${result.failure.reason}`
  }
  return result.failure.attempts
    .map(attempt => `${attempt.adapter} (${attempt.reason}): ${attempt.error}`)
    .join('; ')
}

function failureAdapter(result: Extract<RecursivePriceResult, { path: null }>): string | null {
  return result.failure.attempts.find(attempt => attempt.reason === result.failure.reason)?.adapter
    ?? result.failure.attempts.at(-1)?.adapter
    ?? null
}

function failureOutcome(
  result: Extract<RecursivePriceResult, { path: null }>,
  nowTimestamp: number,
  retryDelaySeconds: number,
): DailyPriceOutcome {
  const reason = failureReason(result)
  const adapter = failureAdapter(result)
  const metadata = {
    resolutionFailure: result.failure.reason,
    resolutionAttempts: result.failure.attempts,
  }

  if (result.failure.reason === 'retryable') {
    return {
      status: 'retryable',
      adapter,
      failureReason: reason,
      nextRetryTimestamp: nowTimestamp + retryDelaySeconds,
      metadata,
    }
  }
  if (result.failure.reason === 'unsupported') {
    return { status: 'unsupported', adapter, failureReason: reason, metadata }
  }
  return {
    status: 'quarantined',
    adapter,
    failureClass: result.failure.reason === 'disagreement' ? 'disagreement' : 'invalid',
    failureReason: reason,
    metadata,
  }
}

function thrownFailure(error: unknown, nowTimestamp: number, retryDelaySeconds: number): DailyPriceOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (isRetryablePricingError(error)) {
    return {
      status: 'retryable',
      failureReason: `Resolver threw a retryable error: ${message}`,
      nextRetryTimestamp: nowTimestamp + retryDelaySeconds,
      metadata: { resolutionFailure: 'retryable' },
    }
  }
  return {
    status: 'quarantined',
    failureClass: 'invalid',
    failureReason: `Resolver threw unexpectedly: ${message}`,
    metadata: { resolutionFailure: 'invalid' },
  }
}

async function resolveDailyPriceTarget(
  resolver: DailyPriceResolver,
  target: DailyPriceTarget,
  nowTimestamp: number,
  retryDelaySeconds: number,
): Promise<ResolvedDailyPriceTarget> {
  let result: RecursivePriceResult
  try {
    result = await resolver.resolve({
      chain: target.chain,
      token: target.token,
      requestedTimestamp: target.eodTimestamp,
      blockNumber: null,
    })
  } catch (error) {
    return { outcome: thrownFailure(error, nowTimestamp, retryDelaySeconds), price: null }
  }

  if (!result.path) {
    return { outcome: failureOutcome(result, nowTimestamp, retryDelaySeconds), price: null }
  }

  return {
    price: pathToWrite(result.path),
    outcome: {
      status: 'priced',
      adapter: result.path.adapter,
      metadata: {
        observedTimestamp: result.path.observedTimestamp,
        observationDistance: result.path.requestedTimestamp - result.path.observedTimestamp,
        source: result.path.source,
        classification: result.path.classification,
        quality: result.path.quality,
      },
    },
  }
}

async function persistResolvedBatch(
  pool: Pool,
  targets: DailyPriceTarget[],
  resolutions: ResolvedDailyPriceTarget[],
  dependencies: DailyPriceWorkerDependencies,
): Promise<void> {
  const insertPrices = dependencies.insertPrices ?? insertTokenPrices
  const prices = resolutions.flatMap(resolution => resolution.price ? [resolution.price] : [])
  const records = targets.map((target, index) => ({
    targetId: target.id,
    attemptCount: target.attemptCount,
    outcome: resolutions[index].outcome,
  }))

  if (dependencies.insertPrices || dependencies.recordOutcomes || dependencies.recordOutcome) {
    await insertPrices(pool, prices)
    if (dependencies.recordOutcomes) {
      await dependencies.recordOutcomes(pool, records)
      return
    }
    if (dependencies.recordOutcome) {
      for (const record of records) {
        await dependencies.recordOutcome(pool, record.targetId, record.attemptCount, record.outcome)
      }
      return
    }
    await recordDailyPriceOutcomes(pool, records)
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const params: number[] = []
    const values = records.map(record => {
      const offset = params.length
      params.push(record.targetId, record.attemptCount)
      return `($${offset + 1}::bigint, $${offset + 2}::integer)`
    })
    const leased = await client.query<{ id: string | number }>(
      `
        WITH expected(id, attempt_count) AS (VALUES ${values.join(', ')})
        SELECT target.id
        FROM daily_price_targets target
        INNER JOIN expected
          ON target.id = expected.id
         AND target.attempt_count = expected.attempt_count
        WHERE target.status = 'in_progress'
        FOR UPDATE OF target
      `,
      params,
    )
    if (leased.rows.length !== records.length) {
      throw new Error(`DailyPrice evidence batch owns ${leased.rows.length} of ${records.length} target leases`)
    }

    await insertTokenPrices(client as unknown as Pool, prices)
    await recordDailyPriceOutcomes(client as unknown as Pool, records)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function persistResolvedTarget(
  pool: Pool,
  target: DailyPriceTarget,
  resolution: ResolvedDailyPriceTarget,
  dependencies: DailyPriceTargetProcessorDependencies,
): Promise<void> {
  if (dependencies.insertPrices || dependencies.recordOutcome) {
    const insertPrices = dependencies.insertPrices ?? insertTokenPrices
    const recordOutcome = dependencies.recordOutcome ?? recordDailyPriceOutcome
    if (resolution.price) await insertPrices(pool, [resolution.price])
    await recordOutcome(pool, target.id, target.attemptCount, resolution.outcome)
    return
  }

  await persistResolvedBatch(pool, [target], [resolution], {})
}

export async function processDailyPriceTarget(
  pool: Pool,
  resolver: DailyPriceResolver,
  target: DailyPriceTarget,
  options: DailyPriceTargetProcessorOptions = {},
  dependencies: DailyPriceTargetProcessorDependencies = {},
): Promise<DailyPriceOutcome> {
  const retryDelaySeconds = assertPositiveInteger(
    options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
    'retryDelaySeconds',
  )
  const nowTimestamp = options.nowTimestamp ?? Math.floor(Date.now() / 1_000)
  const resolution = await resolveDailyPriceTarget(resolver, target, nowTimestamp, retryDelaySeconds)
  await persistResolvedTarget(pool, target, resolution, dependencies)
  return resolution.outcome
}

export async function runDailyPriceWorker(
  pool: Pool,
  resolver: DailyPriceResolver,
  options: DailyPriceWorkerOptions = {},
  dependencies: DailyPriceWorkerDependencies = {},
): Promise<DailyPriceWorkerSummary> {
  const batchSize = assertPositiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize')
  const concurrency = assertPositiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency')
  const leaseSeconds = assertPositiveInteger(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 'leaseSeconds')
  const maxAttempts = assertPositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts')
  const progressEvery = assertPositiveInteger(options.progressEvery ?? DEFAULT_PROGRESS_EVERY, 'progressEvery')
  const maxTargets = options.maxTargets ?? Number.POSITIVE_INFINITY
  if (!(maxTargets === Number.POSITIVE_INFINITY || (Number.isInteger(maxTargets) && maxTargets > 0))) {
    throw new Error('maxTargets must be a positive integer when provided')
  }

  const claimTargets = dependencies.claimTargets ?? claimDailyPriceTargets
  const loadProgress = dependencies.loadProgress ?? getDailyPriceProgress
  const retryDelaySeconds = assertPositiveInteger(
    options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS,
    'retryDelaySeconds',
  )
  const currentTimestamp = () => options.nowTimestamp ?? Math.floor(Date.now() / 1_000)
  const startedTimestamp = currentTimestamp()
  let processed = 0
  let claimedBatches = 0

  await dependencies.validateConfiguration?.()

  while (processed < maxTargets) {
    const limit = Math.min(batchSize, maxTargets - processed)
    const targets = await claimTargets(pool, limit, {
      nowTimestamp: currentTimestamp(),
      leaseSeconds,
      maxAttempts,
    })
    if (targets.length === 0) break
    claimedBatches += 1

    await resolver.prefetch?.(targets.map(target => ({
      chain: target.chain,
      token: target.token,
      requestedTimestamp: target.eodTimestamp,
      blockNumber: null,
    })))

    const resolutions = await mapConcurrentResults(targets, concurrency, target => (
      resolveDailyPriceTarget(resolver, target, currentTimestamp(), retryDelaySeconds)
    ))
    await persistResolvedBatch(pool, targets, resolutions, dependencies)

    const previousProcessed = processed
    processed += targets.length
    const crossedProgressBoundary = Math.floor(previousProcessed / progressEvery) < Math.floor(processed / progressEvery)
    if (options.onProgress && crossedProgressBoundary) {
      const target = targets.at(-1) ?? null
      const progress = buildDailyPriceProgressSnapshot(
        await loadProgress(pool),
        target
          ? {
              chain: target.chain,
              token: target.token,
              eodTimestamp: target.eodTimestamp,
            }
          : null,
      )
      options.onProgress(progress)
    }
  }

  const progress = buildDailyPriceProgressSnapshot(
    await loadProgress(pool),
    null,
    Math.max(currentTimestamp(), startedTimestamp),
  )
  options.onProgress?.(progress)
  return { processed, claimedBatches, progress }
}
