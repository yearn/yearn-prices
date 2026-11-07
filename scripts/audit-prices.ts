import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

loadEnv({ quiet: true })

import { EXACT_READ_CHUNK_SIZE } from '../src/backfill/constants'
import { readPricedKeys } from '../src/backfill/priced-keys'
import { getChainClient } from '../src/clients'
import { createPool, readRepairTargetStates } from '../src/db'
import { normalizedDaysInRange, normalizeToEndOfDay, nowUnix } from '../src/utils'
import { fetchYearnVaults, type NormalizedVault } from './lib/kong-vaults'
import { auditCoverage, auditFailed, auditRepairManifest, expectedTuples } from './lib/price-audit'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const { values } = parseArgs({
  options: {
    backfill: { type: 'boolean' },
    repair: { type: 'boolean' },
    'repair-budget-seconds': { type: 'string', default: '2400' },
    out: { type: 'string' }
  }
})
if (values.repair && values.backfill) throw new Error('Use either --repair or --backfill')
const repairBudget = Number(values['repair-budget-seconds'])
if (!Number.isSafeInteger(repairBudget) || repairBudget < 1 || repairBudget > 2400)
  throw new Error('--repair-budget-seconds must be an integer from 1 through 2400')
const outputDir = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), 'price-audit-'))
mkdirSync(outputDir, { recursive: true })
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
  let repairFailed = false
  writeFileSync(join(outputDir, 'before.json'), JSON.stringify({ window: { start, end }, ...report }, null, 2))
  if (values.repair && report.missing.length > 0) {
    const manifestPath = join(outputDir, 'targets.json')
    writeFileSync(manifestPath, JSON.stringify(auditRepairManifest(report), null, 2))
    console.error(`audit: repairing ${report.missing.length} exact missing token-days`)
    const repair = spawnSync(
      'bun',
      [
        'run',
        'scripts/repair-historical-prices.ts',
        '--write',
        '--manifest',
        manifestPath,
        '--limit',
        String(Math.min(report.missing.length, 10_000)),
        '--budget-seconds',
        String(repairBudget),
        '--lease-seconds',
        String(repairBudget + 600),
        '--out',
        join(outputDir, 'repair')
      ],
      { stdio: ['inherit', 2, 'inherit'], timeout: (repairBudget + 60) * 1000, killSignal: 'SIGKILL' }
    )
    repairFailed = Boolean(repair.error || repair.status !== 0)
    if (repairFailed) console.error(`audit: repair stopped (status=${repair.status}, signal=${repair.signal})`)
    // Keep the original vault list and day window, even if the repair crosses midnight.
    report = await audit(vaults)
  }
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

  writeFileSync(join(outputDir, 'after.json'), JSON.stringify({ window: { start, end }, ...report }, null, 2))
  if (values.repair) {
    const states = await readRepairTargetStates(
      pool,
      auditRepairManifest(report).targets.map((target) => ({
        chainId: target.chainId,
        token: target.token,
        timestamp: target.eodTimestamp
      }))
    )
    writeFileSync(join(outputDir, 'remaining-queue.json'), JSON.stringify(states, null, 2))
  }
  const { missing, ...summary } = report
  console.info(JSON.stringify({ window: { start, end }, missingRpc, warmupFailed, repairFailed, ...summary }))
  if (auditFailed(report, missingRpc, warmupFailed || repairFailed)) {
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
