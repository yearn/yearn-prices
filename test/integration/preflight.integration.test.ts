import { Pool as PgPool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { type BackfillPool, PreflightError, preflightTokenCasings } from '../../scripts/backfill-historical-gaps'
import { EXACT_READ_CHUNK_SIZE } from '../../src/backfill/constants'
import type { NormalizedTarget } from '../../src/backfill/manifest'

const CHAIN = 'ethereum'
const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const EOD = 1_704_153_599

let pool: PgPool

const target: NormalizedTarget = {
  chainId: 1,
  chain: CHAIN,
  token: TOKEN,
  tokenLowercase: TOKEN.toLowerCase(),
  eodTimestamp: EOD
}

async function seedPrice(token: string): Promise<void> {
  await pool.query(
    `INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
     VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7)`,
    [CHAIN, token, EOD, 1.0, 'USDC', 0.99, 'defillama']
  )
}

function preflight(): Promise<void> {
  return preflightTokenCasings(pool as unknown as BackfillPool, [target], EXACT_READ_CHUNK_SIZE)
}

beforeAll(() => {
  pool = new PgPool({ connectionString: inject('databaseUrl'), max: 4 })
})

afterEach(async () => {
  await pool.query('TRUNCATE token_prices, historical_price_gap_inventory')
})

afterAll(async () => {
  await pool.end()
})

describe('preflightTokenCasings', () => {
  it('names a noncanonical casing that would become a consumer-visible duplicate', async () => {
    await seedPrice(TOKEN.toLowerCase())

    await expect(preflight()).rejects.toBeInstanceOf(PreflightError)
    await expect(preflight()).rejects.toThrow(`${CHAIN}:${TOKEN.toLowerCase()}`)
  })

  it('passes when token_prices holds only the canonical casing', async () => {
    await seedPrice(TOKEN)

    await expect(preflight()).resolves.toBeUndefined()
  })

  it('passes when token_prices holds no row for the target at all', async () => {
    await expect(preflight()).resolves.toBeUndefined()
  })
})
