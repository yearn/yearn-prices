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

function buildKeyValues(keys: InventoryKey[]): { valuesSql: string; params: Array<string | number> } {
  const valuesSql: string[] = []
  const params: Array<string | number> = []
  for (const key of keys) {
    const offset = params.length
    valuesSql.push(`($${offset + 1}::bigint, $${offset + 2}::varchar, $${offset + 3}::timestamptz)`)
    params.push(key.chainId, key.tokenLowercase, unixToIsoTimestamp(key.eodTimestamp))
  }
  return { valuesSql: valuesSql.join(', '), params }
}

export async function deleteInventoryRows(db: InventoryQueryable, keys: InventoryKey[]): Promise<void> {
  for (const keyChunk of chunk(keys, INVENTORY_KEY_CHUNK_SIZE)) {
    const { valuesSql, params } = buildKeyValues(keyChunk)
    await db.query(
      `
        DELETE FROM historical_price_gap_inventory AS inventory
        USING (VALUES ${valuesSql}) AS requested(chain_id, token, timestamp)
        WHERE inventory.chain_id = requested.chain_id
          AND inventory.token = requested.token
          AND inventory.timestamp = requested.timestamp
      `,
      params
    )
  }
}

export async function upsertInventoryRows(db: InventoryQueryable, keys: InventoryKey[]): Promise<void> {
  for (const keyChunk of chunk(keys, INVENTORY_KEY_CHUNK_SIZE)) {
    const { valuesSql, params } = buildKeyValues(keyChunk)
    await db.query(
      `
        INSERT INTO historical_price_gap_inventory (chain_id, token, timestamp)
        VALUES ${valuesSql}
        ON CONFLICT (chain_id, token, timestamp) DO NOTHING
      `,
      params
    )
  }
}
