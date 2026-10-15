import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

loadEnv({ quiet: true })

import { EXACT_READ_CHUNK_SIZE } from '../src/backfill/constants'
import { getChainClient } from '../src/clients'
import { createPool, getExistingExactTimestamps } from '../src/db'
import type { PriceSource } from '../src/types'
import { chunk, normalizedDaysInRange, normalizeToEndOfDay, nowUnix } from '../src/utils'
import { fetchYearnVaults, type NormalizedVault } from './lib/kong-vaults'
import { AUDIT_SOURCES, auditCoverage, auditFailed, expectedTuples } from './lib/price-audit'

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
  const existing: Partial<Record<PriceSource, Set<string>>> = {}
  for (const source of AUDIT_SOURCES) {
    const keys = new Set<string>()
    for (const batch of chunk(
      expected.filter((tuple) => tuple.source === source),
      EXACT_READ_CHUNK_SIZE
    )) {
      for (const key of await getExistingExactTimestamps(pool, batch, source)) keys.add(key)
    }
    existing[source] = keys
  }
  return auditCoverage(expected, existing)
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
      ['run', 'scripts/warmup-prices.ts', '--start', String(start), '--end', String(end)],
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

  console.info(JSON.stringify({ window: { start, end }, missingRpc, warmupFailed, ...report }))
  if (auditFailed(report, missingRpc, warmupFailed)) {
    process.exitCode = 1
  }
} finally {
  await pool.end()
}
