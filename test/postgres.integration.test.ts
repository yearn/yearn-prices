import type { Pool } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from '../src/db'
import {
  enqueueDailyPriceTargets,
  getDailyPriceTargets,
  markDailyPriceTargetsPriced,
} from '../src/daily-prices'
import { selectEodPriceEvidence } from '../src/evidence'
import { getBatchHistoricalPriceEvidenceCandidates, insertTokenPrices } from '../src/queries'

const databaseUrl = process.env.DATABASE_URL
const databaseSchema = process.env.DATABASE_SCHEMA
const enabled = Boolean(databaseUrl && databaseSchema?.startsWith('yearn_prices_validation_'))
const TOKEN = '0x00000000000000000000000000000000000000e0'
const EOD = 1_704_153_599

function isolatedDatabaseUrl(): string {
  if (!databaseUrl || !databaseSchema) throw new Error('isolated database is not configured')
  const url = new URL(databaseUrl)
  url.searchParams.set('options', `-c search_path=${databaseSchema}`)
  return url.toString()
}

describe.skipIf(!enabled)('isolated Postgres integration', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createPool(isolatedDatabaseUrl())
    await pool.query('DELETE FROM daily_price_targets WHERE lower(token) = $1', [TOKEN.toLowerCase()])
    await pool.query('DELETE FROM token_prices WHERE lower(token) = $1', [TOKEN.toLowerCase()])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM daily_price_targets WHERE lower(token) = $1', [TOKEN.toLowerCase()])
    await pool.query('DELETE FROM token_prices WHERE lower(token) = $1', [TOKEN.toLowerCase()])
    await pool.end()
  })

  it('executes exact-EOD evidence SQL and excludes an intraday row', async () => {
    await insertTokenPrices(pool, [{
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      price: 2,
      symbol: 'EOD',
      confidence: 1,
      source: 'on-chain-oracle',
      observedTimestamp: EOD,
      classification: 'observed',
      quality: 'exact',
      adapter: 'postgres-canary',
      validationStatus: 'validated',
    }])
    await pool.query(
      `INSERT INTO token_prices (chain, token, timestamp, price, source)
       VALUES ('ethereum', $1, to_timestamp($2), 99, 'defillama')`,
      [TOKEN, EOD - 1],
    )

    const candidates = await getBatchHistoricalPriceEvidenceCandidates(pool, [{
      chain: 'ethereum', token: TOKEN, timestamp: EOD,
    }])
    expect(candidates).toHaveLength(1)
    expect(selectEodPriceEvidence(EOD, candidates).selected).toMatchObject({
      priceUsd: 2,
      adapter: 'postgres-canary',
    })
  })

  it('enqueues idempotently and marks accepted evidence as priced', async () => {
    const input = [{ chain: 'ethereum', token: TOKEN, eodTimestamp: EOD }]
    await expect(enqueueDailyPriceTargets(pool, input)).resolves.toBe(1)
    await expect(enqueueDailyPriceTargets(pool, input)).resolves.toBe(0)
    await expect(markDailyPriceTargetsPriced(pool, input, 'postgres-canary')).resolves.toBe(1)
    await expect(getDailyPriceTargets(pool, input)).resolves.toEqual([
      expect.objectContaining({ status: 'priced', adapter: 'postgres-canary' }),
    ])
  })
})
