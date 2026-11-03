import type { Pool } from '@neondatabase/serverless'
import { ACCEPTED_PRICE_SQL, isRejectedPrice, NOT_REJECTED_PRICE_SQL } from '../prices/rejections'
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

/**
 * Minimal read surface shared by the Neon pool and the backfill's checked-out
 * client. Keeps the source-agnostic gap read decoupled from the concrete driver
 * without erasing types through an `as unknown as Pool` cast.
 */
export interface QueryExecutor {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

function buildSourceCaseExpression(column = 'tp.source'): string {
  return `CASE ${column} ${SOURCE_PRIORITY.map((source, index) => `WHEN '${source}' THEN ${index + 1}`).join(' ')} ELSE 999 END`
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
  source?: PriceSource
): Promise<ExactPriceRecord[]> {
  if (requests.length === 0) {
    return []
  }
  if (requests.length > MAX_EXACT_REQUESTS_PER_QUERY) {
    const rows: ExactPriceRecord[] = []
    for (const part of chunk(requests, MAX_EXACT_REQUESTS_PER_QUERY)) {
      rows.push(...(await getBatchHistoricalPrices(pool, part, source)))
    }
    return rows
  }

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const request of requests) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz)`)
    params.push(request.chain, request.token, unixToIsoTimestamp(request.timestamp))
  }

  const requestedSql = `(VALUES ${valuesSql.join(', ')}) AS r(chain, token, timestamp)`
  let sql: string

  if (source) {
    params.push(source)
    const sourceIndex = params.length
    sql = `
      SELECT tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source,
        tp.observed_at, tp.observation_endpoint
      FROM token_prices tp
      INNER JOIN ${requestedSql}
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp = r.timestamp
      WHERE tp.source = $${sourceIndex} AND ${ACCEPTED_PRICE_SQL}
      ORDER BY tp.chain, tp.token, tp.timestamp
    `
  } else {
    sql = `
      SELECT DISTINCT ON (tp.chain, tp.token, tp.timestamp)
        tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source,
        tp.observed_at, tp.observation_endpoint
      FROM token_prices tp
      INNER JOIN ${requestedSql}
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp = r.timestamp
      WHERE ${ACCEPTED_PRICE_SQL}
      ORDER BY tp.chain, tp.token, tp.timestamp, ${buildSourceCaseExpression()}
    `
  }

  const result = await pool.query<DbPriceRow>(sql, params)
  return result.rows.map(mapDbRowToExactRecord)
}

export async function getRangeHistoricalPrices(
  pool: Pool,
  requests: RangeRequest[],
  source?: PriceSource
): Promise<ExactPriceRecord[]> {
  if (requests.length === 0) {
    return []
  }

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const request of requests) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}::timestamptz)`)
    params.push(
      request.chain,
      request.token,
      unixToIsoTimestamp(request.startTimestamp),
      unixToIsoTimestamp(request.endTimestamp)
    )
  }

  let sql = `
    WITH requested(chain, token, start_timestamp, end_timestamp) AS (
      VALUES ${valuesSql.join(', ')}
    )
  `

  if (source) {
    params.push(source)
    const sourceIndex = params.length
    sql += `
      SELECT tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source,
        tp.observed_at, tp.observation_endpoint
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp BETWEEN r.start_timestamp AND r.end_timestamp
      WHERE tp.source = $${sourceIndex} AND ${ACCEPTED_PRICE_SQL}
      ORDER BY tp.chain, tp.token, tp.timestamp
    `
  } else {
    sql += `
      SELECT DISTINCT ON (tp.chain, tp.token, tp.timestamp)
        tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source,
        tp.observed_at, tp.observation_endpoint
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp BETWEEN r.start_timestamp AND r.end_timestamp
      WHERE ${ACCEPTED_PRICE_SQL}
      ORDER BY tp.chain, tp.token, tp.timestamp, ${buildSourceCaseExpression()}
    `
  }

  const result = await pool.query<DbPriceRow>(sql, params)
  return result.rows.map(mapDbRowToExactRecord)
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

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const request of requests) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz)`)
    params.push(request.chain, request.token, unixToIsoTimestamp(request.timestamp))
  }
  params.push(source)

  const result = await pool.query<DbPriceRow>(
    `
      SELECT tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source,
        tp.observed_at, tp.observation_endpoint
      FROM token_prices tp
      INNER JOIN (VALUES ${valuesSql.join(', ')}) AS r(chain, token, timestamp)
        ON tp.chain = r.chain AND tp.token = r.token AND tp.timestamp = r.timestamp
      WHERE tp.source = $${params.length}
        AND tp.finalized = FALSE
        AND ${NOT_REJECTED_PRICE_SQL}
    `,
    params
  )
  return new Set(result.rows.map((row) => `${row.chain}:${row.token}:${pgTimestampToUnix(row.timestamp)}`))
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

  const valuesSql: string[] = []
  const params: Array<string | number | boolean | null> = []

  for (const row of rows) {
    const offset = params.length
    valuesSql.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::timestamptz, $${offset + 10})`
    )
    params.push(
      row.chain,
      row.token,
      unixToIsoTimestamp(row.timestamp),
      row.price,
      row.symbol,
      row.confidence,
      row.source,
      mode === 'finalize-provisional' ||
        (mode !== 'write-provisional' && !isTodayNormalized(row.timestamp) && mode !== 'mutable-current-day'),
      row.observedTimestamp == null ? null : unixToIsoTimestamp(row.observedTimestamp),
      row.observationEndpoint ?? null
    )
  }

  const conflictSql =
    mode === 'insert-only'
      ? `ON CONFLICT (chain, token, timestamp, source) DO NOTHING`
      : `
      ON CONFLICT (chain, token, timestamp, source)
      DO UPDATE SET
        price = EXCLUDED.price,
        symbol = COALESCE(EXCLUDED.symbol, token_prices.symbol),
        confidence = EXCLUDED.confidence,
        finalized = EXCLUDED.finalized,
        observed_at = EXCLUDED.observed_at,
        observation_endpoint = EXCLUDED.observation_endpoint,
        updated_at = NOW()
      ${mode === 'force' ? '' : 'WHERE token_prices.finalized = FALSE'}
    `

  await pool.query(
    `
      INSERT INTO token_prices (
        chain, token, timestamp, price, symbol, confidence, source,
        finalized, observed_at, observation_endpoint
      )
      VALUES ${valuesSql.join(', ')}
      ${conflictSql}
    `,
    params
  )
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
