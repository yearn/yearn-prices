import { readFile } from 'node:fs/promises'
import { config as loadEnv } from 'dotenv'
import {
  enqueueDailyPriceTargets,
  markDailyPriceTargetsPriced,
  type DailyPriceTargetInput,
} from '../src/daily-prices'
import { createPool } from '../src/db'
import {
  classifyProductionPrice,
  parseProductionEodSnapshotLine,
  productionDailyTarget,
  productionPriceWrite,
  validateProductionEodSnapshot,
} from '../src/production-snapshot'
import { insertTokenPrices } from '../src/queries'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const inputPath = process.argv[2]
if (!inputPath) throw new Error('Usage: bun run daily:import-production <snapshot.jsonl>')

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

const lines = (await readFile(inputPath, 'utf8'))
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)
const records = lines.map((line, index) => parseProductionEodSnapshotLine(line, index + 1))
const { manifest, targets: recordsByTarget } = validateProductionEodSnapshot(records)
const priceRecords = recordsByTarget.filter(record => record.kind === 'price')
const writes = priceRecords.map(record => productionPriceWrite(record, manifest))
const targets = recordsByTarget.map(record => productionDailyTarget(record, manifest))
const acceptedTargets = priceRecords.flatMap(record => (
  classifyProductionPrice(record).accepted ? [productionDailyTarget(record, manifest)] : []
))

const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)
try {
  for (const batch of chunk(writes, 500)) await insertTokenPrices(pool, batch)
  const targetsInserted = await enqueueDailyPriceTargets(pool, targets)
  const targetsMarkedPriced = await markDailyPriceTargetsPriced(
    pool,
    acceptedTargets as DailyPriceTargetInput[],
    'production-yearn-prices-import',
  )
  const importClassifications = recordsByTarget.reduce<Record<string, number>>((counts, record) => {
    const classification = record.kind === 'price'
      ? classifyProductionPrice(record).classification
      : 'missing'
    counts[classification] = (counts[classification] ?? 0) + 1
    return counts
  }, {})
  console.info(JSON.stringify({
    message: 'production-eod-snapshot-imported',
    snapshotGeneratedAt: manifest.generatedAt,
    targets: manifest.targetCount,
    exactEodRowsImported: writes.length,
    targetsInserted,
    targetDuplicates: targets.length - targetsInserted,
    targetsMarkedPriced,
    importClassifications,
  }))
} finally {
  await pool.end()
}
