import { readFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import { enqueueDailyPriceTargets, type DailyPriceTargetInput } from '../src/daily-prices'
import { createPool } from '../src/db'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error('Usage: bun run daily:enqueue-file <targets.jsonl>')
}
function parseTarget(line: string, lineNumber: number): DailyPriceTargetInput {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`Invalid JSON on line ${lineNumber}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Target on line ${lineNumber} must be an object`)
  }
  const target = value as Partial<DailyPriceTargetInput>
  if (typeof target.chain !== 'string' || typeof target.token !== 'string') {
    throw new Error(`Target on line ${lineNumber} requires chain and token`)
  }
  if (typeof target.eodTimestamp !== 'number') {
    throw new Error(`Target on line ${lineNumber} requires eodTimestamp`)
  }
  return {
    chain: target.chain,
    token: target.token,
    eodTimestamp: target.eodTimestamp,
    metadata: target.metadata,
  }
}

const lines = (await readFile(inputPath, 'utf8'))
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
const targets = lines.map((line, index) => parseTarget(line, index + 1))
const pool = createPool(databaseUrl)

try {
  const inserted = await enqueueDailyPriceTargets(pool, targets)
  console.info(JSON.stringify({
    message: 'daily-price-targets-imported',
    inputTargets: targets.length,
    inserted,
    duplicates: targets.length - inserted,
  }))
} finally {
  await pool.end()
}
