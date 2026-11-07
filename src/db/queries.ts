import { and, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { Pool } from '@neondatabase/serverless'
import { database, type DatabaseConnection } from './orm'
import { tokenPrices } from './schema'
import { isRejectedPrice, NOT_REJECTED_PRICE_SQL, SERVED_PRICE_SQL } from '../prices/rejections'
import type {
  DbPriceRow,
  ExactPriceRecord,
  HistoricalRequestTuple,
  PriceSource,
  RangeRequest,
  TokenPriceWrite
} from '../types'
import { SOURCE_PRIORITY } from '../types'
import { chunk } from '../utils/collections'
import { optionalResponseNumber, toResponseNumber } from '../utils/format'
import { isTodayNormalized, pgTimestampToUnix, unixToIsoTimestamp } from '../utils/time'

export type QueryExecutor = DatabaseConnection
export type Queryable = DatabaseConnection

const tp = alias(tokenPrices, 'tp')
const priceSelection = {
  chain: tp.chain,
  token: tp.token,
  timestamp: tp.timestamp,
  price: tp.price,
  symbol: tp.symbol,
  confidence: tp.confidence,
  source: tp.source,
  observed_at: tp.observedAt,
  observation_endpoint: tp.observationEndpoint
}
const sourcePriority = sql`CASE ${tp.source} ${sql.join(
  SOURCE_PRIORITY.map((source, index) => sql`WHEN ${source} THEN ${sql.raw(String(index + 1))}`),
  sql` `
)} ELSE 999 END`

function requestedValues(requests: HistoricalRequestTuple[]) {
  return sql`(VALUES ${sql.join(
    requests.map(
      (request) =>
        sql`(${request.chain}::varchar, ${request.token}::varchar, ${unixToIsoTimestamp(request.timestamp)}::timestamptz)`
    ),
    sql`, `
  )}) AS r(chain, token, timestamp)`
}

export async function getExactHistoricalPrice(
  pool: Pool,
  request: HistoricalRequestTuple,
  source?: PriceSource
): Promise<ExactPriceRecord | null> {
  const rows = await getBatchHistoricalPrices(pool, [request], source)
  return rows[0] ?? null
}

const MAX_EXACT_REQUESTS_PER_QUERY = 10_000

export async function getBatchHistoricalPrices(
  pool: QueryExecutor,
  requests: HistoricalRequestTuple[],
  source?: PriceSource,
  options: { finalizedOnly?: boolean } = {}
): Promise<ExactPriceRecord[]> {
  if (requests.length === 0) {
    return []
  }
  if (requests.length > MAX_EXACT_REQUESTS_PER_QUERY) {
    const rows: ExactPriceRecord[] = []
    for (const part of chunk(requests, MAX_EXACT_REQUESTS_PER_QUERY)) {
      rows.push(...(await getBatchHistoricalPrices(pool, part, source, options)))
    }
    return rows
  }

  const db = database(pool)
  const token = options.finalizedOnly ? sql<string>`r.token` : tp.token
  const selection = { ...priceSelection, token }
  const query = source ? db.select(selection) : db.selectDistinctOn([tp.chain, token, tp.timestamp], selection)
  const rows = await query
    .from(tp)
    .innerJoin(
      requestedValues(requests),
      and(
        sql`${tp.chain} = r.chain`,
        sql`${tp.timestamp} = r.timestamp`,
        options.finalizedOnly ? sql`lower(${tp.token}) = lower(r.token)` : sql`${tp.token} = r.token`
      )
    )
    .where(
      and(
        source ? eq(tp.source, source) : undefined,
        options.finalizedOnly ? sql`${tp.finalized} = TRUE AND ${NOT_REJECTED_PRICE_SQL}` : SERVED_PRICE_SQL
      )
    )
    .orderBy(tp.chain, token, tp.timestamp, sourcePriority)
  return rows.map(mapDbRowToExactRecord)
}

export async function getRangeHistoricalPrices(
  pool: Pool,
  requests: RangeRequest[],
  source?: PriceSource
): Promise<ExactPriceRecord[]> {
  if (requests.length === 0) {
    return []
  }

  const requested = sql`(VALUES ${sql.join(
    requests.map(
      (request) =>
        sql`(${request.chain}::varchar, ${request.token}::varchar, ${unixToIsoTimestamp(request.startTimestamp)}::timestamptz, ${unixToIsoTimestamp(request.endTimestamp)}::timestamptz)`
    ),
    sql`, `
  )}) AS r(chain, token, start_timestamp, end_timestamp)`
  const db = database(pool)
  const query = source
    ? db.select(priceSelection)
    : db.selectDistinctOn([tp.chain, tp.token, tp.timestamp], priceSelection)
  const rows = await query
    .from(tp)
    .innerJoin(
      requested,
      sql`${tp.chain} = r.chain AND ${tp.token} = r.token AND ${tp.timestamp} BETWEEN r.start_timestamp AND r.end_timestamp`
    )
    .where(and(source ? eq(tp.source, source) : undefined, SERVED_PRICE_SQL))
    .orderBy(tp.chain, tp.token, tp.timestamp, sourcePriority)
  return rows.map(mapDbRowToExactRecord)
}

export async function getExistingExactTimestamps(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  source: PriceSource
): Promise<Set<string>> {
  if (requests.length === 0) {
    return new Set()
  }

  const rows = await getBatchHistoricalPrices(pool, requests, source)
  return new Set(rows.map((row) => `${row.chain}:${row.token}:${row.timestamp}`))
}

/** Closed-day rows written before finalization are deliberately excluded from
 * normal price reads. Warmup uses this query to retry those exact targets. */
export async function getUnfinalizedExactTimestamps(
  pool: QueryExecutor,
  requests: HistoricalRequestTuple[],
  source: PriceSource
): Promise<Set<string>> {
  if (requests.length === 0) return new Set()
  if (requests.length > MAX_EXACT_REQUESTS_PER_QUERY) {
    const rows = new Set<string>()
    for (const part of chunk(requests, MAX_EXACT_REQUESTS_PER_QUERY)) {
      for (const key of await getUnfinalizedExactTimestamps(pool, part, source)) rows.add(key)
    }
    return rows
  }

  const rows = await database(pool)
    .select(priceSelection)
    .from(tp)
    .innerJoin(
      requestedValues(requests),
      sql`${tp.chain} = r.chain AND ${tp.token} = r.token AND ${tp.timestamp} = r.timestamp`
    )
    .where(and(eq(tp.source, source), eq(tp.finalized, false), NOT_REJECTED_PRICE_SQL))
  return new Set(rows.map((row) => `${row.chain}:${row.token}:${pgTimestampToUnix(row.timestamp)}`))
}

export async function insertTokenPrices(pool: Queryable, rows: TokenPriceWrite[], forceUpdate = false): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const dedupedRows = dedupeTokenPriceWrites(rows)
  assertFinitePositivePrices(dedupedRows)
  if (forceUpdate) {
    await insertRows(pool, dedupedRows, 'force')
    return
  }

  const immutableRows = dedupedRows.filter((row) => !isTodayNormalized(row.timestamp))
  const mutableRows = dedupedRows.filter((row) => isTodayNormalized(row.timestamp))

  await insertRows(pool, immutableRows, 'insert-only')
  await insertRows(pool, mutableRows, 'mutable-current-day')
}

/** Refreshes only provisional rows after their UTC day has closed, then marks
 * successful observations final. A finalized row is never replaced here. */
export async function finalizeTokenPrices(pool: Queryable, rows: TokenPriceWrite[]): Promise<void> {
  if (rows.length === 0) return
  if (rows.some((row) => isTodayNormalized(row.timestamp))) {
    throw new Error('Cannot finalize a price for the current UTC day')
  }

  const dedupedRows = dedupeTokenPriceWrites(rows)
  assertFinitePositivePrices(dedupedRows)
  await insertRows(pool, dedupedRows, 'finalize-provisional')
}

/** Writes a warmup observation captured before midnight without promoting it
 * if the request or database write finishes after that UTC day has closed. */
export async function insertProvisionalTokenPrices(pool: Queryable, rows: TokenPriceWrite[]): Promise<void> {
  if (rows.length === 0) return
  const dedupedRows = dedupeTokenPriceWrites(rows)
  assertFinitePositivePrices(dedupedRows)
  await insertRows(pool, dedupedRows, 'write-provisional')
}

function assertFinitePositivePrices(rows: TokenPriceWrite[]): void {
  for (const row of rows) {
    const price = Number(row.price)
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `Invalid token price for ${row.chain}:${row.token} at ${row.timestamp}: price must be finite and positive`
      )
    }
    if (row.observedTimestamp != null && !Number.isSafeInteger(row.observedTimestamp)) {
      throw new Error(`Invalid observation timestamp for ${row.chain}:${row.token} at ${row.timestamp}`)
    }
  }
}

function dedupeTokenPriceWrites(rows: TokenPriceWrite[]): TokenPriceWrite[] {
  const keyedRows = new Map<string, TokenPriceWrite>()
  for (const row of rows) {
    if (isRejectedPrice(row.chain, row.token, row.timestamp, row.source)) continue
    keyedRows.set(`${row.chain}:${row.token}:${row.timestamp}:${row.source}`, row)
  }
  return [...keyedRows.values()]
}

type InsertMode = 'insert-only' | 'mutable-current-day' | 'finalize-provisional' | 'write-provisional' | 'force'

async function insertRows(pool: Queryable, rows: TokenPriceWrite[], mode: InsertMode): Promise<void> {
  if (rows.length === 0) {
    return
  }

  // Ten bound columns per row; leave headroom below PostgreSQL's parameter limit.
  for (const batch of chunk(rows, 5_000)) {
    const query = database(pool)
      .insert(tokenPrices)
      .values(
        batch.map((row) => ({
          chain: row.chain,
          token: row.token,
          timestamp: unixToIsoTimestamp(row.timestamp),
          price: String(row.price),
          symbol: row.symbol,
          confidence: row.confidence == null ? null : String(row.confidence),
          source: row.source,
          finalized:
            mode === 'finalize-provisional' ||
            (mode !== 'write-provisional' && !isTodayNormalized(row.timestamp) && mode !== 'mutable-current-day'),
          observedAt: row.observedTimestamp == null ? null : unixToIsoTimestamp(row.observedTimestamp),
          observationEndpoint: row.observationEndpoint ?? null
        }))
      )
    if (mode === 'insert-only') {
      await query.onConflictDoNothing()
    } else {
      await query.onConflictDoUpdate({
        target: [tokenPrices.chain, tokenPrices.token, tokenPrices.timestamp, tokenPrices.source],
        set: {
          price: sql`excluded.price`,
          symbol: sql`coalesce(excluded.symbol, ${tokenPrices.symbol})`,
          confidence: sql`excluded.confidence`,
          finalized: sql`excluded.finalized`,
          observedAt: sql`excluded.observed_at`,
          observationEndpoint: sql`excluded.observation_endpoint`,
          updatedAt: sql`now()`
        },
        setWhere: mode === 'force' ? undefined : eq(tokenPrices.finalized, false)
      })
    }
  }
}

function mapDbRowToExactRecord(row: DbPriceRow): ExactPriceRecord {
  return {
    chain: row.chain,
    token: row.token,
    timestamp: pgTimestampToUnix(row.timestamp),
    price: toResponseNumber(row.price),
    symbol: row.symbol,
    confidence: optionalResponseNumber(row.confidence),
    source: row.source,
    observedTimestamp: row.observed_at == null ? null : pgTimestampToUnix(row.observed_at),
    observationEndpoint: row.observation_endpoint ?? null
  }
}
