import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Pool, type PoolClient } from 'pg'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeEach, expect, inject, it } from 'vitest'
import { repairCurveLpOutlier } from '../../scripts/lib/repair-curve-lp'
import { REJECTED_OBSERVATIONS } from '../../src/prices/rejections'
import { handleHistorical } from '../../src/routes/historical/exact'
import { handleBatchHistorical } from '../../src/routes/historical/batch'
import { handleRangeHistorical } from '../../src/routes/historical/range'
import type { ResolvedPricePath } from '../../src/sources/onchain/types'
import type { Env } from '../../src/types'

const targets = REJECTED_OBSERVATIONS.filter((target) => target.issue === 61)
const token = getAddress(targets[0].token)
const key = `ethereum:${token}`
const env = {} as Env
let pool: Pool
let client: PoolClient
const db = () => client as unknown as NeonPool
const sources = ['', 'defillama', 'defillama-alias', 'curve', 'derived']
function request(path: string, source: string, coins?: unknown) {
  const url = new URL(`https://svc/api/prices/${path}`)
  if (source) url.searchParams.set('source', source)
  if (coins) url.searchParams.set('coins', JSON.stringify(coins))
  return new Request(url)
}

beforeEach(async () => {
  pool ??= new Pool({ connectionString: inject('databaseUrl'), max: 2 })
  client = await pool.connect()
  await client.query('BEGIN')
  // Simulate legacy selectable rows to exercise SQL exclusion independently of
  // the trigger. DDL and data are rolled back together after each case.
  await client.query('ALTER TABLE token_prices DISABLE TRIGGER quarantine_rejected_price')
  for (const target of targets) {
    for (const source of ['defillama', 'defillama-alias']) {
      await client.query(
        `INSERT INTO token_prices (chain, token, timestamp, price, source)
         VALUES ('ethereum', $1, to_timestamp($2), 72061183.43742615, $3)`,
        [token, target.timestamp, source]
      )
    }
  }
  await client.query('ALTER TABLE token_prices ENABLE TRIGGER quarantine_rejected_price')
})

afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})
afterAll(async () => {
  await pool.end()
})

it('omits all eight rejected observations from exact, batch and range selection for every source filter', async () => {
  for (const source of sources) {
    for (const target of targets) {
      await expect(
        handleHistorical(
          request(`historical/${target.timestamp}/${key}`, source),
          env,
          db(),
          String(target.timestamp),
          key
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    const batch = await handleBatchHistorical(
      request('batchHistorical', source, { [key]: targets.map((t) => t.timestamp) }),
      env,
      db()
    )
    expect(await batch.json()).toEqual({ coins: {} })
    const range = await handleRangeHistorical(
      request('rangeHistorical', source, { [key]: [targets[0].timestamp, targets.at(-1)!.timestamp] }),
      env,
      db()
    )
    expect(await range.json()).toEqual({ coins: {} })
  }
})

it('selects dated replacements instead of invalid provider quotes, including a constant-price reference date', async () => {
  for (const [index, target] of targets.entries()) {
    await client.query(
      `INSERT INTO token_prices (chain, token, timestamp, price, source)
       VALUES ('ethereum', $1, to_timestamp($2), $3, 'derived')`,
      [token, target.timestamp, 0.02 + index / 1000]
    )
    for (const source of ['', 'derived']) {
      const response = await handleHistorical(
        request(`historical/${target.timestamp}/${key}`, source),
        env,
        db(),
        String(target.timestamp),
        key
      )
      expect(await response.json()).toMatchObject({
        coins: { [key]: { price: 0.02 + index / 1000, source: 'derived', timestamp: target.timestamp } }
      })
    }
  }
  for (const source of ['', 'derived']) {
    const batch = await handleBatchHistorical(
      request('batchHistorical', source, { [key]: targets.map((t) => t.timestamp) }),
      env,
      db()
    )
    const range = await handleRangeHistorical(
      request('rangeHistorical', source, { [key]: [targets[0].timestamp, targets.at(-1)!.timestamp] }),
      env,
      db()
    )
    for (const response of [batch, range]) {
      const body = (await response.json()) as {
        coins: Record<string, { prices: Array<{ price: number; source: string }> }>
      }
      expect(body.coins[key].prices).toHaveLength(8)
      expect(body.coins[key].prices.every((point) => point.source === 'derived' && point.price < 1)).toBe(true)
    }
  }
  const filtered = await handleBatchHistorical(
    request('batchHistorical', 'defillama', { [key]: targets.map((t) => t.timestamp) }),
    env,
    db()
  )
  expect(await filtered.json()).toEqual({ coins: {} })
})

it('archives rows despite failed replacement and permits a later retry without the original provider row', async () => {
  const target = targets[0]
  const failed = await repairCurveLpOutlier(client, target, true, async () => {
    throw new Error('RPC unavailable')
  })
  expect(failed).toMatchObject({ status: 'unresolved', quarantined: 2 })
  const archived = await client.query(
    `SELECT original_row FROM quarantined_token_prices WHERE original_row->>'token' = $1`,
    [token]
  )
  expect(archived.rows).toHaveLength(2)
  expect(archived.rows[0].original_row.price).toBe(72061183.43742615)
  const path = {
    chainId: 1,
    token,
    requestedTimestamp: target.timestamp,
    observedTimestamp: target.timestamp,
    priceUsd: 0.027,
    source: 'derived',
    adapter: 'curve-reserve-nav',
    symbol: null,
    confidence: null,
    blockNumber: 25233136,
    inputs: [],
    metadata: {}
  } satisfies ResolvedPricePath
  const retry = await repairCurveLpOutlier(client, target, true, async () => path)
  expect(retry.status).toBe('derived')
  const response = await handleHistorical(
    request(`historical/${target.timestamp}/${key}`, ''),
    env,
    db(),
    String(target.timestamp),
    key
  )
  expect(await response.json()).toMatchObject({ coins: { [key]: { source: 'derived', price: 0.027 } } })
})

it('blocks raw reinsertion by an old writer and preserves the rejected payload in quarantine', async () => {
  await client.query('DELETE FROM token_prices')
  for (const target of targets) {
    for (const source of ['defillama', 'defillama-alias']) {
      const inserted = await client.query(
        `INSERT INTO token_prices (chain, token, timestamp, price, source)
         VALUES ('ethereum', $1, to_timestamp($2), 72061183.43742615, $3) RETURNING *`,
        [token, target.timestamp, source]
      )
      expect(inserted.rows).toEqual([])
    }
  }
  expect((await client.query('SELECT * FROM token_prices')).rows).toEqual([])
  expect((await client.query('SELECT * FROM quarantined_token_prices')).rows).toHaveLength(16)
})
