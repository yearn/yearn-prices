import { sql } from 'drizzle-orm'
import { executeSql } from '../../src/db/orm'
import { type RepairQueueDb, type RepairTarget, readFinalizedRepairKeys } from '../../src/db/repair-queue'
import { NOT_REJECTED_PRICE_SQL } from '../../src/prices/rejections'
import { CHAIN_ID_TO_NAME, chainIdToName, normalizeTokenAddress } from '../../src/utils/chains'
import { currentUtcDayEnd, nowUnix } from '../../src/utils/time'

export type { RepairTarget } from '../../src/db/repair-queue'
export const REPAIR_DISCOVERY_LIMIT = 10_000

function targetKey(target: RepairTarget): string {
  return `${target.chainId}:${target.token.toLowerCase()}:${target.timestamp}`
}

export function dedupeRepairTargets(targets: RepairTarget[]): RepairTarget[] {
  const unique = new Map<string, RepairTarget>()
  for (const target of targets) {
    if (!chainIdToName(target.chainId)) continue
    const normalized = { ...target, token: normalizeTokenAddress(target.token) }
    if (!unique.has(targetKey(normalized))) unique.set(targetKey(normalized), normalized)
  }
  return [...unique.values()].sort(
    (a, b) => a.chainId - b.chainId || a.timestamp - b.timestamp || a.token.localeCompare(b.token)
  )
}

export const finalizedRepairKeys = readFinalizedRepairKeys

/**
 * Discovery is bounded per run and skips targets already queued or finalized.
 * Once a page is enqueued it is excluded from the next run, so an unresolved
 * old target cannot permanently hide later provisional rows behind a LIMIT.
 */
export async function discoverRepairTargets(
  db: RepairQueueDb,
  roots: RepairTarget[],
  recentClosedDays: number
): Promise<{
  targets: RepairTarget[]
  finalized: number
  provisionalSelected: number
  inventorySelected: number
  misalignedSkipped: number
  discoveryLimit: number
}> {
  if (!Number.isSafeInteger(recentClosedDays) || recentClosedDays < 1 || recentClosedDays > 365) {
    throw new Error('recentClosedDays must be an integer from 1 through 365')
  }
  const todayEnd = currentUtcDayEnd(nowUnix())
  const days = Array.from({ length: recentClosedDays }, (_, index) => todayEnd - (index + 1) * 86_400)
  const recent = dedupeRepairTargets(roots).flatMap((root) => days.map((timestamp) => ({ ...root, timestamp })))
  type Row = { chain_id: number | string; token: string; timestamp: string | Date }
  const extras: RepairTarget[] = []
  const counts: number[] = []
  let misalignedSkipped = 0
  for (const kind of ['provisional', 'inventory'] as const) {
    // Both alternatives are fixed SQL. User input is passed only as parameters.
    const candidates =
      kind === 'provisional'
        ? sql`SELECT DISTINCT c.chain_id, c.chain, lower(p.token) AS token, p.timestamp
         FROM token_prices p JOIN chains c ON p.chain = c.chain
         WHERE p.finalized = FALSE AND p.timestamp < to_timestamp(${todayEnd})`
        : sql`SELECT c.chain_id, c.chain, i.token, i.timestamp
         FROM historical_price_gap_inventory i JOIN chains c ON i.chain_id = c.chain_id
         WHERE i.timestamp < to_timestamp(${todayEnd})`
    const result = await executeSql<Row>(
      db,
      sql`WITH chains AS (
         SELECT key::bigint AS chain_id, value AS chain FROM jsonb_each_text(${JSON.stringify(CHAIN_ID_TO_NAME)}::jsonb)
       ), candidates AS (${candidates})
       SELECT r.chain_id, r.token, r.timestamp FROM candidates r
       WHERE NOT EXISTS (
         SELECT 1 FROM historical_price_repair_queue q
         WHERE q.chain_id = r.chain_id AND q.token = r.token AND q.timestamp = r.timestamp
           AND q.completed_at IS NULL
       ) AND NOT EXISTS (
         SELECT 1 FROM token_prices tp
         WHERE tp.chain = r.chain AND lower(tp.token) = r.token AND tp.timestamp = r.timestamp
           AND tp.finalized = TRUE AND tp.price > 0
           AND tp.price::text NOT IN ('NaN', 'Infinity', '-Infinity')
           AND ${NOT_REJECTED_PRICE_SQL}
       )
       ORDER BY r.timestamp, r.chain_id, r.token LIMIT ${REPAIR_DISCOVERY_LIMIT}`
    )
    counts.push(result.rows.length)
    for (const row of result.rows) {
      const timestamp = Math.floor(new Date(row.timestamp).getTime() / 1000)
      if (timestamp % 86_400 !== 86_399) {
        misalignedSkipped += 1
        console.error(
          JSON.stringify({
            message: 'repair-discovery-misaligned',
            kind,
            chainId: row.chain_id,
            token: row.token,
            timestamp
          })
        )
        continue
      }
      extras.push({ chainId: Number(row.chain_id), token: normalizeTokenAddress(row.token), timestamp })
    }
  }
  const targets = dedupeRepairTargets([...recent, ...extras])
  const finalized = await readFinalizedRepairKeys(db, targets)
  return {
    targets: targets.filter((target) => !finalized.has(targetKey(target))),
    finalized: finalized.size,
    provisionalSelected: counts[0],
    inventorySelected: counts[1],
    misalignedSkipped,
    discoveryLimit: REPAIR_DISCOVERY_LIMIT
  }
}
