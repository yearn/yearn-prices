import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

loadEnv({ quiet: true })

import { EXACT_READ_CHUNK_SIZE } from '../src/backfill/constants'
import { readPricedKeys } from '../src/backfill/priced-keys'
import { getChainClient } from '../src/clients'
import { createPool } from '../src/db'
import { normalizedDaysInRange, normalizeToEndOfDay, nowUnix } from '../src/utils'
import { fetchYearnVaults, type NormalizedVault } from './lib/kong-vaults'
import { auditCoverage, auditFailed, expectedTuples } from './lib/price-audit'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const { values } = parseArgs({ options: { backfill: { type: 'boolean' } } })
const pool = createPool(databaseUrl)
// Current-day observations are served live and remain provisional. Scheduled
// coverage audits measure finalized history, not whether someone requested today.
const end = normalizeToEndOfDay(nowUnix()) - 86_400
const start = normalizeToEndOfDay(end - 6 * 86_400)
const timestamps = normalizedDaysInRange(start, end)

async function audit(vaults: NormalizedVault[]) {
  const expected = expectedTuples(vaults, timestamps)
  const priced = await readPricedKeys(
    pool,
    expected.map((tuple) => ({ chain: tuple.chain, token: tuple.token, eodTimestamp: tuple.timestamp })),
    EXACT_READ_CHUNK_SIZE,
    { finalizedOnly: true }
  )
  return auditCoverage(expected, priced)
}

try {
  const vaults = await fetchYearnVaults()
  if (vaults.length === 0) throw new Error('audit: Kong returned no usable vaults')
  const missingRpc = [...new Set(vaults.map((vault) => vault.chainId))].filter((chainId) => !getChainClient(chainId))
  if (missingRpc.length)
    console.error(`audit: missing RPC configuration: ${missingRpc.map((id) => `RPC_URL_${id}`).join(', ')}`)

  let report = await audit(vaults)
  let warmupFailed = false
  if (values.backfill && report.missing.length > 0 && missingRpc.length === 0) {
    console.error(`audit: ${report.missing.length} gaps, running warmup`)
    const warmup = spawnSync(
      'bun',
      ['run', 'scripts/warmup-prices.ts', '--start', String(start), '--end', String(end), '--graph', '--quiet'],
      {
        stdio: ['inherit', 2, 'inherit']
      }
    )
    if (warmup.error || warmup.status !== 0) {
      console.error(`audit: warmup failed (status=${warmup.status}, signal=${warmup.signal})`, warmup.error)
      warmupFailed = true
    }
    report = await audit(vaults)
  }

  const { missing, ...summary } = report
  console.info(JSON.stringify({ window: { start, end }, missingRpc, warmupFailed, ...summary }))
  if (auditFailed(report, missingRpc, warmupFailed)) {
    const byToken: Record<string, number> = {}
    for (const tuple of missing) {
      const key = `${tuple.chain}:${tuple.token} ${tuple.kind}`
      byToken[key] = (byToken[key] ?? 0) + 1
    }
    for (const [key, days] of Object.entries(byToken)) console.error(`audit: missing ${key} days=${days}`)
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
