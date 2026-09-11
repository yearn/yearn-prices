/**
 * One-off repair of DeFiLlama prices stored against the wrong day.
 *
 * Phases: prices (refetch and rewrite), derived (rescale vault prices by the
 * repair ratio of their underlying), verify, cleanup. Run `all` or one phase.
 * Flags: --out <report.json>, --retry[=db|<file>], --concurrency <n>.
 *
 * Deliberately not repaired by the derived phase: vaults missing from Kong and
 * nested vaults (vault-of-vault). Days whose derived price may have come from a
 * non-defillama underlying source are counted as ambiguous-underlying-source and
 * still rescaled: derivation provenance is not stored, so exact exclusion is not
 * derivable from the data.
 *
 * Both this script and the hourly warmup write token_prices.updated_at with a
 * naive NOW(); the derived phase compares it against repaired_at assuming both
 * sessions are UTC (Neon's default). Pause the warmup workflow while running
 * prices/derived: rows warmup rewrites after stampRepairedAt are skipped.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

loadEnv()

import { DefiLlamaClient } from '../src/clients'
import { createPool, insertTokenPrices, type Queryable } from '../src/db'
import { DEFI_LLAMA_TIMESTAMP_BATCH } from '../src/sources/defillama/batch'
import { buildDefiLlamaWrites } from '../src/sources/defillama/match'
import { computeRepairRatios } from '../src/sources/defillama/repair-ratio'
import type { TokenPriceWrite } from '../src/types'
import {
  chainIdToName,
  chunk,
  isTodayNormalized,
  normalizedDaysInRange,
  normalizeToEndOfDay,
  pgTimestampToUnix,
  runInGroups,
  unixToIsoTimestamp
} from '../src/utils'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const pool = createPool(databaseUrl)

const cliArgs = process.argv
  .slice(2)
  .map((arg, index, all) =>
    arg === '--retry' && (all[index + 1] === undefined || all[index + 1].startsWith('--')) ? '--retry=db' : arg
  )
const { values: flags, positionals } = parseArgs({
  args: cliArgs,
  options: {
    out: { type: 'string' },
    retry: { type: 'string' },
    concurrency: { type: 'string' }
  },
  allowPositionals: true
})

const REPORT_PATH = flags.out ?? 'backfill-report.json'
const RETRY_PATH = flags.retry ?? ''

const PHASES = ['prices', 'derived', 'verify', 'cleanup', 'all'] as const
const unknownPhase = positionals.find((arg) => !PHASES.includes(arg as (typeof PHASES)[number]))
if (unknownPhase) {
  throw new Error(`unknown phase "${unknownPhase}". Expected one of ${PHASES.join(', ')}`)
}
const phase = positionals[0] ?? 'all'

interface MissingDay {
  chain: string
  token: string
  timestamp: number
  day: string
  kind: 'gap' | 'not-found' | 'stale-row'
}

interface FailedToken {
  chain: string
  token: string
  reason: string
}

const report: { startedAt: string; missing: MissingDay[]; failed: FailedToken[] } = {
  startedAt: new Date().toISOString(),
  missing: [],
  failed: []
}

async function writeReport(quiet = false): Promise<void> {
  await writeFile(REPORT_PATH, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))
  if (!quiet) {
    console.log(`report ${REPORT_PATH} missing=${report.missing.length} failed=${report.failed.length}`)
  }
}

process.on('SIGINT', () => {
  void writeReport().finally(() => process.exit(130))
})

const parsedConcurrency = Number(flags.concurrency)
const TOKEN_CONCURRENCY =
  Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? Math.floor(parsedConcurrency) : 4

console.log(`starting phase=${phase} concurrency=${TOKEN_CONCURRENCY} retry=${RETRY_PATH || 'none'} out=${REPORT_PATH}`)

const defiLlama = new DefiLlamaClient()
const KONG_URL = 'https://kong.yearn.fi/api/rest/list/vaults?origin=yearn'

interface TokenRow {
  chain: string
  token: string
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('404')
}

const SCRATCH_TABLES = ['backfill_progress', 'defillama_repair_ratio', 'backfill_missing', 'vault_underlying_map']

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      token_key TEXT PRIMARY KEY,
      done_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS defillama_repair_ratio (
      chain     TEXT NOT NULL,
      token     TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      ratio     NUMERIC NOT NULL,
      applied   BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (chain, token, timestamp)
    )
  `)
  await pool.query('ALTER TABLE defillama_repair_ratio ADD COLUMN IF NOT EXISTS repaired_at TIMESTAMPTZ')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_missing (
      chain     TEXT NOT NULL,
      token     TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      kind      TEXT NOT NULL,
      PRIMARY KEY (chain, token, timestamp)
    )
  `)
}

async function dropScratchTables(): Promise<void> {
  for (const table of SCRATCH_TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${table}`)
  }
  console.log(`dropped ${SCRATCH_TABLES.join(', ')}`)
}

async function stampRepairedAt(): Promise<void> {
  const { rowCount } = await pool.query(`
    UPDATE defillama_repair_ratio r
    SET repaired_at = bp.done_at
    FROM backfill_progress bp
    WHERE bp.token_key = r.chain || ':' || r.token
      AND r.repaired_at IS NULL
  `)
  if (rowCount) {
    console.log(`stamped repaired_at on ${rowCount} legacy ratios`)
  }
}

async function persistBatch(
  chain: string,
  token: string,
  writes: TokenPriceWrite[],
  storedPrices: Map<number, number>,
  missing: MissingDay[]
): Promise<void> {
  if (writes.length === 0 && missing.length === 0) {
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await insertTokenPrices(client, writes, true)
    await recordRatios(client, chain, token, writes, storedPrices)
    await recordMissing(client, missing)
    await clearMissing(client, chain, token, writes)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  report.missing.push(...missing)
}

async function clearMissing(client: Queryable, chain: string, token: string, writes: TokenPriceWrite[]): Promise<void> {
  if (writes.length === 0) {
    return
  }

  await client.query(
    `DELETE FROM backfill_missing
     WHERE chain = $1 AND token = $2 AND timestamp = ANY($3::timestamptz[])`,
    [chain, token, writes.map((write) => unixToIsoTimestamp(write.timestamp))]
  )
}

async function recordMissing(client: Queryable, missing: MissingDay[]): Promise<void> {
  if (missing.length === 0) {
    return
  }

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const entry of missing) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4})`)
    params.push(entry.chain, entry.token, unixToIsoTimestamp(entry.timestamp), entry.kind)
  }

  await client.query(
    `INSERT INTO backfill_missing (chain, token, timestamp, kind)
     VALUES ${valuesSql.join(', ')}
     ON CONFLICT (chain, token, timestamp) DO UPDATE SET kind = EXCLUDED.kind`,
    params
  )
}

async function repairPrices(): Promise<void> {
  await ensureTables()
  await stampRepairedAt()

  const tokens = await selectTokens()
  console.log(`tokens pending=${tokens.length}`)

  let processed = 0
  let updated = 0
  let gaps = 0
  let notFound = 0
  const failedTokens: string[] = []

  await runInGroups(tokens, TOKEN_CONCURRENCY, 0, async ({ chain, token }) => {
    const coinKey = `${chain}:${token.toLowerCase()}`

    try {
      const { rows: days } = await pool.query<{ timestamp: string; price: string }>(
        `SELECT timestamp, price FROM token_prices WHERE chain = $1 AND token = $2 AND source = 'defillama' ORDER BY 1`,
        [chain, token]
      )
      const storedTimestamps = days.map((day) => pgTimestampToUnix(day.timestamp))
      const storedPrices = new Map(days.map((day) => [pgTimestampToUnix(day.timestamp), Number(day.price)]))
      const repairTimestamps =
        storedTimestamps.length > 0
          ? normalizedDaysInRange(Math.min(...storedTimestamps) - 86_400, Math.max(...storedTimestamps)).filter(
              (timestamp) => !isTodayNormalized(timestamp)
            )
          : []

      let transientFailure = false

      for (const fetchTimestamps of chunk(repairTimestamps, DEFI_LLAMA_TIMESTAMP_BATCH)) {
        let coin:
          | { symbol?: string | null; prices: Array<{ timestamp: number; price: number; confidence?: number | null }> }
          | undefined
        try {
          const response = await defiLlama.getBatchHistorical({ [coinKey]: fetchTimestamps })
          coin = response.coins[coinKey]
        } catch (error) {
          if (isNotFound(error)) {
            notFound += fetchTimestamps.length
            const missing = fetchTimestamps.map((fetchTimestamp) =>
              describeMissing(chain, token, fetchTimestamp, 'not-found')
            )
            await persistBatch(chain, token, [], storedPrices, missing)
            console.warn(`not-found ${coinKey} ${fetchTimestamps.length} days`)
            continue
          }
          transientFailure = true
          report.failed.push({ chain, token, reason: String(error) })
          console.error(`batch failed ${coinKey}: ${String(error)}`)
          break
        }

        const built = buildDefiLlamaWrites(chain, token, fetchTimestamps, coin)
        const writes = built.writes
        const batchMissing: MissingDay[] = []
        for (const fetchTimestamp of built.missing) {
          gaps += 1
          const stale = storedPrices.has(normalizeToEndOfDay(fetchTimestamp))
          const missing = describeMissing(chain, token, fetchTimestamp, stale ? 'stale-row' : 'gap')
          batchMissing.push(missing)
          console.warn(`${missing.kind} ${coinKey} ${missing.day}`)
        }

        try {
          await persistBatch(chain, token, writes, storedPrices, batchMissing)
          updated += writes.length
        } catch (error) {
          transientFailure = true
          report.failed.push({ chain, token, reason: String(error) })
          console.error(`write failed ${coinKey}: ${String(error)}`)
          break
        }
      }

      if (transientFailure) {
        failedTokens.push(coinKey)
      } else {
        await pool.query('INSERT INTO backfill_progress (token_key) VALUES ($1) ON CONFLICT DO NOTHING', [
          `${chain}:${token}`
        ])
      }
    } catch (error) {
      failedTokens.push(coinKey)
      report.failed.push({ chain, token, reason: String(error) })
      console.error(`token failed ${coinKey}: ${String(error)}`)
    }

    processed += 1
    if (processed % 25 === 0) {
      await writeReport(true)
      console.log(
        `progress tokens=${processed}/${tokens.length} rows=${updated} gaps=${gaps} notFound=${notFound} failed=${failedTokens.length}`
      )
    }
  })

  console.log(
    `prices done tokens=${processed} rows=${updated} gaps=${gaps} notFound=${notFound} failed=${failedTokens.length}`
  )
  if (failedTokens.length > 0) {
    console.log(`retry: bun run scripts/backfill-defillama-day-alignment.ts prices --retry=${REPORT_PATH}`)
  }
}

function describeMissing(chain: string, token: string, fetchTimestamp: number, kind: MissingDay['kind']): MissingDay {
  const timestamp = normalizeToEndOfDay(fetchTimestamp)
  return { chain, token, timestamp, day: new Date(timestamp * 1000).toISOString().slice(0, 10), kind }
}

async function selectTokens(): Promise<TokenRow[]> {
  if (!RETRY_PATH) {
    const { rows } = await pool.query<TokenRow>(`
      SELECT DISTINCT tp.chain, tp.token
      FROM token_prices tp
      WHERE tp.source = 'defillama'
        AND NOT EXISTS (
          SELECT 1 FROM backfill_progress bp WHERE bp.token_key = tp.chain || ':' || tp.token
        )
      ORDER BY 1, 2
    `)
    return rows
  }

  if (RETRY_PATH === 'db') {
    const { rows } = await pool.query<TokenRow>(`
      SELECT DISTINCT chain, token FROM backfill_missing ORDER BY 1, 2
    `)
    if (rows.length > 0) {
      await pool.query('DELETE FROM backfill_progress WHERE token_key = ANY($1::text[])', [
        rows.map((entry) => `${entry.chain}:${entry.token}`)
      ])
    }
    console.log(`retrying ${rows.length} tokens from backfill_missing`)
    return rows
  }

  let previous: { missing?: MissingDay[]; failed?: FailedToken[] }
  try {
    const raw = (await readFile(RETRY_PATH, 'utf8')).trim()
    if (raw.length === 0) {
      throw new Error('file is empty')
    }
    previous = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `cannot retry from ${RETRY_PATH}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Drop --retry to resume from the progress table instead.'
    )
  }
  const keyed = new Map<string, TokenRow>()
  for (const entry of [...(previous.failed ?? []), ...(previous.missing ?? [])]) {
    keyed.set(`${entry.chain}:${entry.token}`, { chain: entry.chain, token: entry.token })
  }

  const tokens = [...keyed.values()]
  if (tokens.length > 0) {
    await pool.query('DELETE FROM backfill_progress WHERE token_key = ANY($1::text[])', [
      tokens.map((entry) => `${entry.chain}:${entry.token}`)
    ])
  }
  console.log(`retrying ${tokens.length} tokens from ${RETRY_PATH}`)
  return tokens
}

async function recordRatios(
  client: Queryable,
  chain: string,
  token: string,
  writes: TokenPriceWrite[],
  storedPrices: Map<number, number>
): Promise<void> {
  const ratios = computeRepairRatios(writes, storedPrices)
  if (ratios.length === 0) {
    return
  }

  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const { timestamp, ratio } of ratios) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::timestamptz, $${offset + 4}, NOW())`)
    params.push(chain, token, unixToIsoTimestamp(timestamp), ratio)
  }

  await client.query(
    `INSERT INTO defillama_repair_ratio (chain, token, timestamp, ratio, repaired_at)
     VALUES ${valuesSql.join(', ')}
     ON CONFLICT (chain, token, timestamp) DO UPDATE
       SET ratio = CASE
             WHEN defillama_repair_ratio.applied THEN EXCLUDED.ratio
             ELSE defillama_repair_ratio.ratio * EXCLUDED.ratio
           END,
           applied = FALSE,
           repaired_at = EXCLUDED.repaired_at`,
    params
  )
}

async function loadVaultUnderlyings(): Promise<void> {
  const response = await fetch(KONG_URL)
  if (!response.ok) {
    throw new Error(`Kong list failed: ${response.status}`)
  }
  const items = (await response.json()) as Array<{
    chainId: number
    address: string
    asset?: { address?: string }
  }>

  const pairs: Array<[string, string, string]> = []
  for (const item of items) {
    const chain = chainIdToName(item.chainId)
    if (!chain || !item.address || !item.asset?.address) {
      continue
    }
    pairs.push([chain, item.address.toLowerCase(), item.asset.address.toLowerCase()])
  }

  await pool.query('DROP TABLE IF EXISTS vault_underlying_map')
  await pool.query(`
    CREATE TABLE vault_underlying_map (
      chain      TEXT NOT NULL,
      vault      TEXT NOT NULL,
      underlying TEXT NOT NULL,
      PRIMARY KEY (chain, vault)
    )
  `)

  for (const group of chunk(pairs, 500)) {
    const valuesSql = group.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(', ')
    await pool.query(
      `INSERT INTO vault_underlying_map (chain, vault, underlying) VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
      group.flat()
    )
  }

  console.log(`vault map rows=${pairs.length}`)
}

async function rescaleDerived(): Promise<void> {
  await ensureTables()
  await stampRepairedAt()
  await loadVaultUnderlyings()

  const { rows: chains } = await pool.query<{ chain: string }>(
    `SELECT DISTINCT chain FROM token_prices WHERE source = 'derived' ORDER BY 1`
  )

  let total = 0
  for (const { chain } of chains) {
    const result = await pool.query(
      `
      WITH targets AS (
        SELECT d.chain, d.token, d.timestamp, r.token AS ratio_token, d.price * r.ratio AS new_price
        FROM token_prices d
        JOIN vault_underlying_map m ON m.chain = d.chain AND m.vault = lower(d.token)
        JOIN defillama_repair_ratio r
          ON r.chain = d.chain
         AND lower(r.token) = m.underlying
         AND r.timestamp = d.timestamp
         AND NOT r.applied
         AND r.repaired_at IS NOT NULL
         AND COALESCE(d.updated_at, '-infinity'::timestamp) AT TIME ZONE 'UTC' < r.repaired_at
        WHERE d.source = 'derived' AND d.chain = $1
      ), rescaled AS (
        UPDATE token_prices d
        SET price = t.new_price, updated_at = NOW() AT TIME ZONE 'UTC'
        FROM targets t
        WHERE d.source = 'derived'
          AND d.chain = t.chain
          AND d.token = t.token
          AND d.timestamp = t.timestamp
        RETURNING d.chain AS chain, t.ratio_token AS ratio_token, d.timestamp AS timestamp
      ), marked AS (
        UPDATE defillama_repair_ratio r
        SET applied = TRUE
        FROM rescaled x
        WHERE r.chain = x.chain AND r.token = x.ratio_token AND r.timestamp = x.timestamp
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM rescaled) AS updated, (SELECT count(*) FROM marked) AS marked
      `,
      [chain]
    )
    const updated = Number(result.rows[0]?.updated ?? 0)
    const marked = Number(result.rows[0]?.marked ?? 0)
    total += updated
    console.log(`derived ${chain} updated=${updated} ratios-marked=${marked}`)
  }

  const { rows: orphans } = await pool.query<{ count: string }>(`
    SELECT count(*) count
    FROM (SELECT DISTINCT chain, token FROM token_prices WHERE source = 'derived') d
    WHERE NOT EXISTS (
      SELECT 1 FROM vault_underlying_map m WHERE m.chain = d.chain AND m.vault = lower(d.token)
    )
  `)
  const { rows: ambiguous } = await pool.query<{ count: string }>(`
    SELECT count(*) count
    FROM token_prices d
    JOIN vault_underlying_map m ON m.chain = d.chain AND m.vault = lower(d.token)
    JOIN defillama_repair_ratio r
      ON r.chain = d.chain AND lower(r.token) = m.underlying AND r.timestamp = d.timestamp
    WHERE d.source = 'derived'
      AND EXISTS (
        SELECT 1 FROM token_prices u
        WHERE u.chain = d.chain AND lower(u.token) = m.underlying AND u.timestamp = d.timestamp
          AND u.source NOT IN ('defillama', 'derived')
      )
  `)
  console.log(
    `derived done updated=${total} vaults-not-in-kong=${orphans[0].count} ambiguous-underlying-source=${ambiguous[0].count}`
  )
}

async function verify(): Promise<void> {
  const { rows } = await pool.query<{ chain: string; token: string; timestamp: string; price: string }>(`
    SELECT chain, token, timestamp, price
    FROM token_prices
    WHERE source = 'defillama'
      AND chain = 'ethereum'
      AND lower(token) IN (
        '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e',
        '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'
      )
      AND timestamp >= '2025-08-16T23:59:59Z'
      AND timestamp <= '2025-08-21T23:59:59Z'
    ORDER BY token, timestamp
  `)

  for (const row of rows) {
    const timestamp = pgTimestampToUnix(row.timestamp)
    const coinKey = `ethereum:${row.token.toLowerCase()}`
    const response = await defiLlama.getHistorical(timestamp, [coinKey])
    const remote = response.coins[coinKey]?.price
    const stored = Number(row.price)
    const ok = remote != null && Math.abs(stored - remote) / remote < 0.0001
    console.log(
      `${row.token.slice(0, 8)} ${new Date(timestamp * 1000).toISOString().slice(0, 10)} stored=${stored} llama=${remote} ${ok ? 'ok' : 'MISMATCH'}`
    )
  }
}

try {
  if (phase === 'prices' || phase === 'all') {
    await repairPrices()
  }
  if (phase === 'derived' || phase === 'all') {
    await rescaleDerived()
  }
  if (phase === 'verify') {
    await verify()
  }
  if (phase === 'cleanup') {
    await dropScratchTables()
  }
} catch (error) {
  console.error(`phase ${phase} failed: ${String(error)}`)
  process.exitCode = 1
} finally {
  if (phase === 'prices' || phase === 'all') {
    await writeReport()
  }
  await pool.end()
}
