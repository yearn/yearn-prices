import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

loadEnv({ quiet: true })

import { getChainClient } from '../src/clients'
import { createPool, getExistingExactTimestamps } from '../src/db'
import { normalizedDaysInRange, normalizeToEndOfDay, nowUnix } from '../src/utils'
import { fetchYearnVaults, type NormalizedVault } from './lib/kong-vaults'
import { AUDIT_SOURCES, auditCoverage, expectedTuples } from './lib/price-audit'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const { values } = parseArgs({ options: { backfill: { type: 'boolean' } } })
const pool = createPool(databaseUrl)
const end = normalizeToEndOfDay(nowUnix())
const start = normalizeToEndOfDay(end - 6 * 86_400)
const timestamps = normalizedDaysInRange(start, end)

async function audit(vaults: NormalizedVault[]) {
  const expected = expectedTuples(vaults, timestamps)
  const existing = Object.fromEntries(
    await Promise.all(
      AUDIT_SOURCES.map(async (source) => [source, await getExistingExactTimestamps(pool, expected, source)] as const)
    )
  )
  return auditCoverage(expected, existing)
}

try {
  const vaults = await fetchYearnVaults()
  const missingRpc = [...new Set(vaults.map((vault) => vault.chainId))].filter((chainId) => !getChainClient(chainId))

  let report = await audit(vaults)
  if (values.backfill && report.missing.length > 0) {
    console.error(`audit: ${report.missing.length} gaps, running warmup`)
    spawnSync('bun', ['run', 'scripts/warmup-prices.ts'], { stdio: ['inherit', 2, 'inherit'] })
    report = await audit(vaults)
  }

  console.info(JSON.stringify({ window: { start, end }, missingRpc, ...report }))
  if (report.missing.length > 0 || missingRpc.length > 0) {
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
