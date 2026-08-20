import type { Pool } from '@neondatabase/serverless'
import type { PriceSource } from '../types'
import { pgTimestampToUnix, unixToIsoTimestamp } from '../utils/time'
import { EXACT_READ_CHUNK_SIZE, FINALIZATION_BATCH_SIZE, FINALIZATION_LOCK_RETRY_LIMIT } from './constants'
import { chunk, deleteInventoryRows, type InventoryKey, upsertInventoryRows } from './inventory'
import { priceKey, readPricedKeys } from './priced-keys'

const LOCK_NOT_AVAILABLE = '55P03'
const TIMEOUT_LITERAL_PATTERN = /^\d+(ms|s|min)$/

export const DEFAULT_LOCK_TIMEOUT = '5s'
export const DEFAULT_STATEMENT_TIMEOUT = '30s'

export interface BackfillQueryResult {
  rows: Record<string, unknown>[]
}

export interface BackfillClient {
  query(sql: string, params?: unknown[]): Promise<BackfillQueryResult>
  release(): void
}

export interface BackfillClientPool {
  connect(): Promise<BackfillClient>
}

export interface FinalizationResolution {
  price: number
  symbol: string | null
  confidence: number | null
  source: PriceSource
}

export interface FinalizationTarget {
  chainId: number
  chain: string
  token: string
  tokenLowercase: string
  eodTimestamp: number
  resolution: FinalizationResolution | null
}

export type FinalizationStatus = 'inserted' | 'skipped_concurrent_existing' | 'unresolved'

export interface FinalizationTargetResult {
  chainId: number
  chain: string
  token: string
  tokenLowercase: string
  eodTimestamp: number
  status: FinalizationStatus
}

export interface FinalizationOptions {
  dryRun?: boolean
  batchSize?: number
  lockRetryLimit?: number
  lockTimeout?: string
  statementTimeout?: string
  readChunkSize?: number
}

export interface FinalizationOutcome {
  results: FinalizationTargetResult[]
  inserted: number
  skippedConcurrentExisting: number
  unresolved: number
  lockRetries: number
}

export class FinalizationLockError extends Error {
  readonly attempts: number

  constructor(attempts: number, cause: unknown) {
    super(`Finalization batch failed to acquire the token_prices lock after ${attempts} attempts`)
    this.name = 'FinalizationLockError'
    this.attempts = attempts
    this.cause = cause
  }
}

function timeoutLiteral(value: string): string {
  if (!TIMEOUT_LITERAL_PATTERN.test(value)) {
    throw new Error(`Invalid transaction timeout literal: ${value}`)
  }
  return value
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE
}

function inventoryKey(target: FinalizationTarget): InventoryKey {
  return {
    chainId: target.chainId,
    tokenLowercase: target.tokenLowercase,
    eodTimestamp: target.eodTimestamp
  }
}

function toResult(target: FinalizationTarget, status: FinalizationStatus): FinalizationTargetResult {
  return {
    chainId: target.chainId,
    chain: target.chain,
    token: target.token,
    tokenLowercase: target.tokenLowercase,
    eodTimestamp: target.eodTimestamp,
    status
  }
}

async function insertResolvedTargets(client: BackfillClient, targets: FinalizationTarget[]): Promise<Set<string>> {
  if (targets.length === 0) {
    return new Set()
  }

  const valuesSql: string[] = []
  const params: Array<string | number | null> = []
  for (const target of targets) {
    const resolution = target.resolution as FinalizationResolution
    const offset = params.length
    valuesSql.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
    )
    params.push(
      target.chain,
      target.token,
      unixToIsoTimestamp(target.eodTimestamp),
      resolution.price,
      resolution.symbol,
      resolution.confidence,
      resolution.source
    )
  }

  const result = await client.query(
    `
      INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
      VALUES ${valuesSql.join(', ')}
      ON CONFLICT (chain, token, timestamp, source) DO NOTHING
      RETURNING chain, token, timestamp
    `,
    params
  )

  const inserted = new Set<string>()
  for (const row of result.rows) {
    inserted.add(priceKey(row.chain as string, row.token as string, pgTimestampToUnix(row.timestamp as string | Date)))
  }
  return inserted
}

async function applyBatch(
  client: BackfillClient,
  batch: FinalizationTarget[],
  readChunkSize: number,
  write: boolean
): Promise<FinalizationTargetResult[]> {
  const priced = await readPricedKeys(client as unknown as Pool, batch, readChunkSize)

  const concurrent: FinalizationTarget[] = []
  const resolved: FinalizationTarget[] = []
  const unresolved: FinalizationTarget[] = []

  for (const target of batch) {
    if (priced.has(priceKey(target.chain, target.token, target.eodTimestamp))) {
      concurrent.push(target)
    } else if (target.resolution) {
      resolved.push(target)
    } else {
      unresolved.push(target)
    }
  }

  if (!write) {
    return [
      ...concurrent.map((target) => toResult(target, 'skipped_concurrent_existing')),
      ...resolved.map((target) => toResult(target, 'inserted')),
      ...unresolved.map((target) => toResult(target, 'unresolved'))
    ]
  }

  const insertedKeys = await insertResolvedTargets(client, resolved)
  const results: FinalizationTargetResult[] = [
    ...concurrent.map((target) => toResult(target, 'skipped_concurrent_existing')),
    ...unresolved.map((target) => toResult(target, 'unresolved'))
  ]

  const settled: FinalizationTarget[] = [...concurrent]
  for (const target of resolved) {
    const inserted = insertedKeys.has(priceKey(target.chain, target.token, target.eodTimestamp))
    results.push(toResult(target, inserted ? 'inserted' : 'skipped_concurrent_existing'))
    settled.push(target)
  }

  await deleteInventoryRows(client, settled.map(inventoryKey))
  await upsertInventoryRows(client, unresolved.map(inventoryKey))

  return results
}

async function finalizeBatch(
  pool: BackfillClientPool,
  batch: FinalizationTarget[],
  options: Required<Omit<FinalizationOptions, 'dryRun' | 'batchSize'>>
): Promise<{ results: FinalizationTargetResult[]; lockRetries: number }> {
  const lockTimeout = timeoutLiteral(options.lockTimeout)
  const statementTimeout = timeoutLiteral(options.statementTimeout)
  let retries = 0

  for (;;) {
    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`)
      await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`)
      await client.query('LOCK TABLE token_prices IN SHARE ROW EXCLUSIVE MODE')
      const results = await applyBatch(client, batch, options.readChunkSize, true)
      await client.query('COMMIT')
      committed = true
      return { results, lockRetries: retries }
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK')
        } catch {}
      }
      if (!isLockTimeout(error)) {
        throw error
      }
      if (retries >= options.lockRetryLimit) {
        throw new FinalizationLockError(retries + 1, error)
      }
      retries += 1
    } finally {
      client.release()
    }
  }
}

async function finalizeDryRun(
  pool: BackfillClientPool,
  batch: FinalizationTarget[],
  readChunkSize: number
): Promise<FinalizationTargetResult[]> {
  const client = await pool.connect()
  try {
    return await applyBatch(client, batch, readChunkSize, false)
  } finally {
    client.release()
  }
}

export async function finalizeBackfillTargets(
  pool: BackfillClientPool,
  targets: FinalizationTarget[],
  options: FinalizationOptions = {}
): Promise<FinalizationOutcome> {
  const batchSize = options.batchSize ?? FINALIZATION_BATCH_SIZE
  const transactionOptions = {
    lockRetryLimit: options.lockRetryLimit ?? FINALIZATION_LOCK_RETRY_LIMIT,
    lockTimeout: options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT,
    statementTimeout: options.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT,
    readChunkSize: options.readChunkSize ?? EXACT_READ_CHUNK_SIZE
  }

  const results: FinalizationTargetResult[] = []
  let lockRetries = 0

  for (const batch of chunk(targets, batchSize)) {
    if (options.dryRun) {
      results.push(...(await finalizeDryRun(pool, batch, transactionOptions.readChunkSize)))
      continue
    }

    const outcome = await finalizeBatch(pool, batch, transactionOptions)
    results.push(...outcome.results)
    lockRetries += outcome.lockRetries
  }

  return {
    results,
    inserted: results.filter((result) => result.status === 'inserted').length,
    skippedConcurrentExisting: results.filter((result) => result.status === 'skipped_concurrent_existing').length,
    unresolved: results.filter((result) => result.status === 'unresolved').length,
    lockRetries
  }
}
