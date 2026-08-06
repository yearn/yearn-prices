import { writeFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import {
  buildDailyEvidenceExport,
  type DailyEvidenceCandidateRow,
  type DailyEvidenceTargetRow,
} from '../src/daily-evidence-export'
import { createPool } from '../src/db'
import { latestClosedUtcDayEnd, unixToIsoTimestamp } from '../src/time'

loadEnv()

function argument(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const rawEod = argument('--eod')
const output = argument('--output')
const expectedTargets = Number(argument('--expected-targets'))
if (!rawEod || !output) throw new Error('--eod and --output are required')
const eodTimestamp = Number(rawEod)
if (!Number.isSafeInteger(eodTimestamp) || eodTimestamp !== latestClosedUtcDayEnd(eodTimestamp + 1)) {
  throw new Error('--eod must be an exact closed UTC day-end timestamp')
}
if (!Number.isSafeInteger(expectedTargets) || expectedTargets <= 0) {
  throw new Error('--expected-targets must be a positive integer')
}

const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)
try {
  const eod = unixToIsoTimestamp(eodTimestamp)
  const [targetResult, candidateResult] = await Promise.all([
    pool.query<DailyEvidenceTargetRow>(`
      SELECT chain, token, eod_at, status, adapter, failure_class, failure_reason, metadata
      FROM daily_price_targets
      WHERE eod_at = $1
      ORDER BY chain, LOWER(token)
    `, [eod]),
    pool.query<DailyEvidenceCandidateRow>(`
      SELECT
        chain, token, timestamp, price, symbol, confidence, source, candidate_id,
        observed_at, evidence_kind, quality, adapter, block_number, input_evidence,
        validation_status, failure_reason
      FROM token_prices
      WHERE timestamp = $1
      ORDER BY chain, LOWER(token), candidate_id
    `, [eod]),
  ])

  if (targetResult.rows.length !== expectedTargets) {
    throw new Error(`Expected ${expectedTargets} targets, found ${targetResult.rows.length}`)
  }
  const nonterminal = targetResult.rows.filter(row => ['pending', 'in_progress', 'retryable'].includes(row.status))
  if (nonterminal.length > 0) {
    throw new Error(`Evidence export requires terminal targets; found ${nonterminal.length} nonterminal rows`)
  }

  const evidence = buildDailyEvidenceExport(eodTimestamp, targetResult.rows, candidateResult.rows)
  const pricedWithoutValidatedEvidence = evidence.targets.filter(target => (
    target.status === 'priced' && target.validationState !== 'validated'
  ))
  if (pricedWithoutValidatedEvidence.length > 0) {
    throw new Error(`Found ${pricedWithoutValidatedEvidence.length} priced targets without selected validated evidence`)
  }

  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  console.info(JSON.stringify({
    message: 'daily-price-evidence-exported',
    output,
    eodTimestamp,
    targetCount: evidence.targetCount,
    outcomes: evidence.outcomes,
  }, null, 2))
} finally {
  await pool.end()
}
