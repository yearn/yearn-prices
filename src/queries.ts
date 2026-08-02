import type { Pool } from '@neondatabase/serverless'
import {
  SOURCE_PRIORITY,
  type DbPriceEvidenceRow,
  type DbPriceRow,
  type ExactPriceRecord,
  type HistoricalRequestTuple,
  type PriceEvidenceCandidate,
  type PriceEvidenceInput,
  type PriceSource,
  type RangeRequest,
  type TokenPriceWrite,
} from './types'
import { optionalResponseNumber, toResponseNumber } from './format'
import { pgTimestampToUnix, unixToIsoTimestamp, isTodayNormalized, normalizeToEndOfDay } from './time'

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

export async function getHistoricalPriceEvidenceCandidates(
  pool: Pool,
  request: HistoricalRequestTuple,
  source?: PriceSource,
): Promise<PriceEvidenceCandidate[]> {
  return getBatchHistoricalPriceEvidenceCandidates(pool, [request], source)
}

export async function getBatchHistoricalPriceEvidenceCandidates(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  source?: PriceSource,
): Promise<PriceEvidenceCandidate[]> {
  if (requests.length === 0) return []

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const [requestIndex, request] of requests.entries()) {
    if (normalizeToEndOfDay(request.timestamp) !== request.timestamp) {
      throw new Error('Evidence queries require an exact UTC EOD timestamp')
    }
    const offset = params.length
    valuesSql.push(
      `($${offset + 1}::integer, $${offset + 2}, $${offset + 3}, $${offset + 4}::timestamptz)`,
    )
    params.push(requestIndex, request.chain, request.token, unixToIsoTimestamp(request.timestamp))
  }
  const sourceFilter = source
    ? (() => {
        params.push(source)
        return `AND price.source = $${params.length}`
      })()
    : ''
  const observedAt = 'COALESCE(price.observed_at, price.timestamp)'

  const result = await pool.query<DbPriceEvidenceRow>(
    `
      WITH requested(request_index, chain, token, requested_timestamp) AS (
        VALUES ${valuesSql.join(', ')}
      )
      SELECT
        price.chain,
        price.token,
        price.timestamp,
        price.price,
        price.symbol,
        price.confidence,
        price.source,
        requested.requested_timestamp,
        ${observedAt} AS observed_timestamp,
        price.evidence_kind,
        price.quality,
        price.adapter,
        price.block_number,
        price.input_evidence,
        price.validation_status,
        price.failure_reason,
        price.evidence_metadata
      FROM requested
      INNER JOIN token_prices price
        ON price.chain = requested.chain
       AND price.token = requested.token
       AND price.timestamp = requested.requested_timestamp
      WHERE TRUE
        ${sourceFilter}
      ORDER BY requested.request_index, ${buildSourceCaseExpression('price.source')}, price.adapter
    `,
    params,
  )

  return result.rows.map(mapDbRowToEvidenceCandidate)
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

  const dedupedRows = dedupeTokenPriceWrites(rows)
  const immutableRows = dedupedRows.filter(row => !isTodayNormalized(row.timestamp))
  const mutableRows = dedupedRows.filter(row => isTodayNormalized(row.timestamp))

  await insertRows(pool, immutableRows, false)
  await insertRows(pool, mutableRows, true)
}

function dedupeTokenPriceWrites(rows: TokenPriceWrite[]): TokenPriceWrite[] {
  const keyedRows = new Map<string, TokenPriceWrite>()
  for (const row of rows) {
    keyedRows.set(`${row.chain}:${row.token}:${row.timestamp}:${row.source}`, row)
  }
  return [...keyedRows.values()]
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
      `($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::timestamptz, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}::jsonb, $${offset + 14}, $${offset + 15}, $${offset + 16}::jsonb)`,
    )
    params.push(
      row.chain,
      row.token,
      unixToIsoTimestamp(row.timestamp),
      row.price,
      row.symbol,
      row.confidence,
      row.source,
      row.observedTimestamp == null ? null : unixToIsoTimestamp(row.observedTimestamp),
      row.classification ?? null,
      row.quality ?? null,
      row.adapter ?? null,
      row.blockNumber ?? null,
      row.inputs ? JSON.stringify(row.inputs) : null,
      row.validationStatus ?? null,
      row.failureReason ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    )
  }

  const updateAssignments = `
        price = EXCLUDED.price,
        symbol = EXCLUDED.symbol,
        confidence = EXCLUDED.confidence,
        observed_at = EXCLUDED.observed_at,
        evidence_kind = EXCLUDED.evidence_kind,
        quality = EXCLUDED.quality,
        adapter = EXCLUDED.adapter,
        block_number = EXCLUDED.block_number,
        input_evidence = EXCLUDED.input_evidence,
        validation_status = EXCLUDED.validation_status,
        failure_reason = EXCLUDED.failure_reason,
        evidence_metadata = EXCLUDED.evidence_metadata,
        updated_at = NOW()
  `
  const conflictSql = updateOnConflict
    ? `
      ON CONFLICT (chain, token, timestamp, source)
      DO UPDATE SET
        ${updateAssignments}
      WHERE EXCLUDED.validation_status = 'validated'
        OR COALESCE(token_prices.validation_status, 'legacy-unvalidated') = 'legacy-unvalidated'
    `
    : `
      ON CONFLICT (chain, token, timestamp, source)
      DO UPDATE SET
        ${updateAssignments}
      WHERE EXCLUDED.validation_status = 'validated'
        AND COALESCE(token_prices.validation_status, 'legacy-unvalidated') = 'legacy-unvalidated'
    `

  await pool.query(
    `
      INSERT INTO token_prices (
        chain,
        token,
        timestamp,
        price,
        symbol,
        confidence,
        source,
        observed_at,
        evidence_kind,
        quality,
        adapter,
        block_number,
        input_evidence,
        validation_status,
        failure_reason,
        evidence_metadata
      )
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

function mapDbRowToEvidenceCandidate(row: DbPriceEvidenceRow): PriceEvidenceCandidate {
  const requestedTimestamp = pgTimestampToUnix(row.requested_timestamp)
  const observedTimestamp = pgTimestampToUnix(row.observed_timestamp)
  const observationOffsetSeconds = observedTimestamp - requestedTimestamp
  const blockNumber = row.block_number == null ? null : Number(row.block_number)

  return {
    chain: row.chain,
    token: row.token,
    requestedTimestamp,
    observedTimestamp,
    observationDistance: Math.abs(observationOffsetSeconds),
    observationOffsetSeconds,
    observationDirection: observationOffsetSeconds === 0
      ? 'exact'
      : observationOffsetSeconds < 0
        ? 'before'
        : 'after',
    priceUsd: toResponseNumber(row.price),
    symbol: row.symbol,
    confidence: optionalResponseNumber(row.confidence),
    source: row.source,
    adapter: row.adapter,
    classification: row.evidence_kind ?? 'legacy',
    quality: row.quality ?? 'legacy',
    blockNumber: Number.isSafeInteger(blockNumber) ? blockNumber : null,
    inputs: parseEvidenceInputs(row.input_evidence),
    validationStatus: row.validation_status ?? 'legacy-unvalidated',
    failureReason: row.failure_reason,
    metadata: parseEvidenceMetadata(row.evidence_metadata),
  }
}

function parseEvidenceInputs(value: unknown): PriceEvidenceInput[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as PriceEvidenceInput[] : []
}

function parseEvidenceMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
