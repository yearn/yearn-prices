import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeEach, expect, inject, it } from 'vitest'
import { claimRepairQueue, type RepairQueueDb } from '../../src/db/repair-queue'

let pool: Pool
let client: PoolClient
const day = Math.floor(Date.now() / 86_400_000) * 86_400 - 1
const token = (id: number) => `0x${id.toString(16).padStart(40, '0')}`
const target = (id: number, timestamp = day) => ({ chainId: 1, token: token(id), timestamp })
const db = () => client as unknown as RepairQueueDb

beforeEach(async () => {
  pool ??= new Pool({ connectionString: inject('databaseUrl'), max: 2 })
  client = await pool.connect()
  await client.query('BEGIN')
  await client.query(`CREATE TEMP TABLE historical_price_repair_queue
    (LIKE public.historical_price_repair_queue INCLUDING ALL) ON COMMIT DROP`)
  for (const item of [target(1), target(1, day - 86400), target(2), target(3), target(4)]) {
    await client.query(
      `INSERT INTO historical_price_repair_queue (chain_id, token, timestamp)
       VALUES ($1, $2, to_timestamp($3))`,
      [item.chainId, item.token, item.timestamp]
    )
  }
  await client.query(
    `UPDATE historical_price_repair_queue SET next_attempt_at = now() + interval '1 hour'
    WHERE token = $1`,
    [token(3)]
  )
  await client.query(
    `UPDATE historical_price_repair_queue
    SET lease_owner = 'other', lease_token = 'other', lease_expires_at = now() + interval '1 hour'
    WHERE token = $1`,
    [token(4)]
  )
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})
afterAll(async () => {
  await pool.end()
})

it('claims only exact manifest pairs while respecting cooldowns and other workers', async () => {
  const claims = await claimRepairQueue(db(), {
    owner: 'audit',
    leaseSeconds: 300,
    limit: 100,
    targets: [target(1), target(3), target(4)]
  })
  expect(claims.map(({ chainId, token, timestamp }) => ({ chainId, token, timestamp }))).toEqual([target(1)])
  const untouched = await client.query(
    `SELECT token, timestamp, lease_owner FROM historical_price_repair_queue
    WHERE token = $1 OR (token = $2 AND timestamp = to_timestamp($3))`,
    [token(2), token(1), day - 86400]
  )
  expect(untouched.rows).toHaveLength(2)
  expect(untouched.rows.every((row) => row.lease_owner === null)).toBe(true)
})

it('an empty manifest never falls back to claiming the global backlog', async () => {
  expect(await claimRepairQueue(db(), { owner: 'audit', leaseSeconds: 300, limit: 100, targets: [] })).toEqual([])
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM historical_price_repair_queue WHERE lease_owner = 'audit'`
  )
  expect(rows[0].count).toBe(0)
})
