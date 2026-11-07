import { sql } from 'drizzle-orm'
import { database } from '../db/orm'
import { historicalPriceGapInventory as inventory } from '../db/schema'
import { chunk } from '../utils/collections'
import { unixToIsoTimestamp } from '../utils/time'

export interface InventoryQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface InventoryKey {
  chainId: number
  tokenLowercase: string
  eodTimestamp: number
}

const INVENTORY_KEY_CHUNK_SIZE = 1_000

export async function deleteInventoryRows(db: InventoryQueryable, keys: InventoryKey[]): Promise<void> {
  for (const batch of chunk(keys, INVENTORY_KEY_CHUNK_SIZE)) {
    const requested = sql`(VALUES ${sql.join(
      batch.map(
        (key) =>
          sql`(${key.chainId}::bigint, ${key.tokenLowercase}::varchar, ${unixToIsoTimestamp(key.eodTimestamp)}::timestamptz)`
      ),
      sql`, `
    )}) AS requested(chain_id, token, timestamp)`
    await database(db)
      .delete(inventory)
      .where(sql`(${inventory.chainId}, ${inventory.token}, ${inventory.timestamp}) IN (SELECT * FROM ${requested})`)
  }
}

export async function upsertInventoryRows(db: InventoryQueryable, keys: InventoryKey[]): Promise<void> {
  for (const batch of chunk(keys, INVENTORY_KEY_CHUNK_SIZE)) {
    await database(db)
      .insert(inventory)
      .values(
        batch.map((key) => ({
          chainId: key.chainId,
          token: key.tokenLowercase,
          timestamp: unixToIsoTimestamp(key.eodTimestamp)
        }))
      )
      .onConflictDoNothing()
  }
}
