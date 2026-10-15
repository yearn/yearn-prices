import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
import { parseManifest } from '../src/backfill/manifest'
import { createPool } from '../src/db'
import { runGraphBackfill } from './lib/graph-backfill'

config({ quiet: true })
const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    out: { type: 'string' },
    write: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'database-url-env': { type: 'string', default: 'DATABASE_URL' },
    concurrency: { type: 'string', default: '2' },
    'provider-rps': { type: 'string', default: '1' }
  }
})
if (!values.manifest || !values.out || (values.write && values['dry-run']))
  throw new Error('Required: --manifest <file> --out <new report.jsonl>; use --write OR --dry-run')
const manifest = parseManifest(readFileSync(values.manifest))
const databaseUrl = process.env[values['database-url-env']]
if (!databaseUrl) throw new Error('Missing database connection configuration')
const pool = createPool(databaseUrl)
try {
  await runGraphBackfill({
    pool,
    manifest,
    out: resolve(values.out),
    write: values.write,
    concurrency: Number(values.concurrency),
    providerRps: Number(values['provider-rps'])
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await pool.end()
}
