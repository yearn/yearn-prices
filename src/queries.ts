import type { Pool } from '@neondatabase/serverless'
import { SOURCE_PRIORITY, type DbPriceRow, type ExactPriceRecord, type HistoricalRequestTuple, type PriceSource, type RangeRequest, type TokenPriceWrite } from './types'
import { optionalResponseNumber, toResponseNumber } from './format'
import { pgTimestampToUnix, unixToIsoTimestamp, isTodayNormalized } from './time'

function buildSourceCaseExpression(column = 'tp.source'): string {
  return `CASE ${column} ${SOURCE_PRIORITY.map((source, index) => `WHEN '${source}' THEN ${index + 1}`).join(' ')} ELSE 999 END`
}

export async function getExactHistoricalPrice(
  pool: Pool,
  request: HistoricalRequestTuple,
  source?: PriceSource,
): Promise<ExactPriceRecord | null> {
  const rows = await getBatchHistoricalPrices(pool, [request], source)
  return rows[0] ?? null
}

export async function getBatchHistoricalPrices(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  source?: PriceSource,
): Promise<ExactPriceRecord[]> {
  if (requests.length === 0) {
    return []
  }

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const request of requests) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz)`)
    params.push(request.chain, request.token, unixToIsoTimestamp(request.timestamp))
  }

  let sql = `
    WITH requested(chain, token, timestamp) AS (
      VALUES ${valuesSql.join(', ')}
    )
  `

  if (source) {
    params.push(source)
    const sourceIndex = params.length
    sql += `
      SELECT tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp = r.timestamp
      WHERE tp.source = $${sourceIndex}
      ORDER BY tp.chain, tp.token, tp.timestamp
    `
  } else {
    sql += `
      SELECT DISTINCT ON (tp.chain, tp.token, tp.timestamp)
        tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp = r.timestamp
      ORDER BY tp.chain, tp.token, tp.timestamp, ${buildSourceCaseExpression()}
    `
  }

  const result = await pool.query<DbPriceRow>(sql, params)
  return result.rows.map(mapDbRowToExactRecord)
}

export async function getRangeHistoricalPrices(
  pool: Pool,
  requests: RangeRequest[],
  source?: PriceSource,
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
      unixToIsoTimestamp(request.endTimestamp),
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
      SELECT tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp BETWEEN r.start_timestamp AND r.end_timestamp
      WHERE tp.source = $${sourceIndex}
      ORDER BY tp.chain, tp.token, tp.timestamp
    `
  } else {
    sql += `
      SELECT DISTINCT ON (tp.chain, tp.token, tp.timestamp)
        tp.chain, tp.token, tp.timestamp, tp.price, tp.symbol, tp.confidence, tp.source
      FROM token_prices tp
      INNER JOIN requested r
        ON tp.chain = r.chain
       AND tp.token = r.token
       AND tp.timestamp BETWEEN r.start_timestamp AND r.end_timestamp
      ORDER BY tp.chain, tp.token, tp.timestamp, ${buildSourceCaseExpression()}
    `
  }

  const result = await pool.query<DbPriceRow>(sql, params)
  return result.rows.map(mapDbRowToExactRecord)
}

export async function getExistingExactTimestamps(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  source: PriceSource,
): Promise<Set<string>> {
  if (requests.length === 0) {
    return new Set()
  }

  const rows = await getBatchHistoricalPrices(pool, requests, source)
  return new Set(rows.map(row => `${row.chain}:${row.token}:${row.timestamp}`))
}

export async function insertTokenPrices(pool: Pool, rows: TokenPriceWrite[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const immutableRows = rows.filter(row => !isTodayNormalized(row.timestamp))
  const mutableRows = rows.filter(row => isTodayNormalized(row.timestamp))

  await insertRows(pool, immutableRows, false)
  await insertRows(pool, mutableRows, true)
}

async function insertRows(pool: Pool, rows: TokenPriceWrite[], updateOnConflict: boolean): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const valuesSql: string[] = []
  const params: Array<string | number | null> = []

  for (const row of rows) {
    const offset = params.length
    valuesSql.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
    )
    params.push(
      row.chain,
      row.token,
      unixToIsoTimestamp(row.timestamp),
      row.price,
      row.symbol,
      row.confidence,
      row.source,
    )
  }

  const conflictSql = updateOnConflict
    ? `
      ON CONFLICT (chain, token, timestamp, source)
      DO UPDATE SET
        price = EXCLUDED.price,
        symbol = EXCLUDED.symbol,
        confidence = EXCLUDED.confidence
    `
    : `
      ON CONFLICT (chain, token, timestamp, source) DO NOTHING
    `

  await pool.query(
    `
      INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
      VALUES ${valuesSql.join(', ')}
      ${conflictSql}
    `,
    params,
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
  }
}
