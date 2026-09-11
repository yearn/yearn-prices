import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Pool as PgPool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import {
  type BackfillClient,
  type BackfillClientPool,
  FinalizationLockError,
  type FinalizationTarget,
  finalizeBackfillTargets
} from '../../src/backfill/finalize'
import { getBatchHistoricalPrices, insertTokenPrices } from '../../src/db/queries'
import { type PriceSource, SOURCE_PRIORITY } from '../../src/types'

const CHAIN = 'ethereum'
const CHAIN_ID = 1
const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TOKEN_LOWERCASE = TOKEN.toLowerCase()
const EOD = 1_704_153_599
const OBSERVED = EOD + 126

let pool: PgPool

function neonPool(): NeonPool {
  return pool as unknown as NeonPool
}

function backfillPool(): BackfillClientPool {
  return pool as unknown as BackfillClientPool
}

function target(overrides: Partial<FinalizationTarget> = {}): FinalizationTarget {
  return {
    chainId: CHAIN_ID,
    chain: CHAIN,
    token: TOKEN,
    tokenLowercase: TOKEN_LOWERCASE,
    eodTimestamp: EOD,
    resolution: { price: 1.0012, symbol: 'USDC', confidence: 0.99, source: 'defillama' },
    ...overrides
  }
}

async function seedPrice(source: PriceSource, price = 2.5, timestamp = EOD): Promise<void> {
  await pool.query(
    `INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
     VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7)`,
    [CHAIN, TOKEN, timestamp, price, 'USDC', 0.5, source]
  )
}

async function priceRows(): Promise<Array<{ price: string; source: string; timestamp: Date }>> {
  const result = await pool.query('SELECT price, source, timestamp FROM token_prices ORDER BY source')
  return result.rows
}

async function inventoryRows(): Promise<Array<{ chain_id: string; token: string; timestamp: Date }>> {
  const result = await pool.query('SELECT chain_id, token, timestamp FROM historical_price_gap_inventory')
  return result.rows
}

beforeAll(() => {
  pool = new PgPool({ connectionString: inject('databaseUrl'), max: 8 })
})

afterEach(async () => {
  await pool.query('TRUNCATE token_prices, historical_price_gap_inventory')
})

afterAll(async () => {
  await pool.end()
})

describe('source-agnostic gap detection', () => {
  it.each(SOURCE_PRIORITY)('a %s row makes the target already priced', async (source) => {
    await seedPrice(source)
    const rows = await getBatchHistoricalPrices(neonPool(), [{ chain: CHAIN, token: TOKEN, timestamp: EOD }])
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe(source)
  })

  it('no exact row makes the target eligible', async () => {
    await seedPrice('defillama', 2.5, EOD - 86_400)
    const rows = await getBatchHistoricalPrices(neonPool(), [{ chain: CHAIN, token: TOKEN, timestamp: EOD }])
    expect(rows).toEqual([])
  })
})

describe('finalization writes', () => {
  it('inserts the resolved price at the requested EOD, not the observed timestamp', async () => {
    const outcome = await finalizeBackfillTargets(backfillPool(), [target()])

    expect(outcome.inserted).toBe(1)
    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('defillama')
    expect(Number(rows[0].price)).toBeCloseTo(1.0012)
    expect(Math.floor(rows[0].timestamp.getTime() / 1000)).toBe(EOD)
    expect(Math.floor(rows[0].timestamp.getTime() / 1000)).not.toBe(OBSERVED)
  })

  it('skips the row on a rerun instead of updating it', async () => {
    await finalizeBackfillTargets(backfillPool(), [target()])
    const outcome = await finalizeBackfillTargets(backfillPool(), [
      target({ resolution: { price: 9.99, symbol: 'USDC', confidence: 0.1, source: 'defillama' } })
    ])

    expect(outcome.results[0].status).toBe('skipped_concurrent_existing')
    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].price)).toBeCloseTo(1.0012)
  })

  it('never updates an existing same-source row', async () => {
    await seedPrice('defillama', 2.5)
    const outcome = await finalizeBackfillTargets(backfillPool(), [target()])

    expect(outcome.results[0].status).toBe('skipped_concurrent_existing')
    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].price)).toBeCloseTo(2.5)
  })

  it('reports a different-source row committed before the guard as skipped_concurrent_existing', async () => {
    await seedPrice('curve', 3.5)
    const outcome = await finalizeBackfillTargets(backfillPool(), [target()])

    expect(outcome.skippedConcurrentExisting).toBe(1)
    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('curve')
  })

  it('sets bounded transaction-local timeouts and locks immediately before the recheck', async () => {
    const statements: string[] = []
    const recording: BackfillClientPool = {
      connect: async () => {
        const client = (await pool.connect()) as unknown as BackfillClient
        return {
          query: (sql: string, params?: unknown[]) => {
            statements.push(sql.trim().split('\n')[0].trim())
            return client.query(sql, params)
          },
          release: () => client.release()
        }
      }
    }

    await finalizeBackfillTargets(recording, [target()], { lockTimeout: '900ms', statementTimeout: '7s' })

    expect(statements.slice(0, 4)).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '900ms'",
      "SET LOCAL statement_timeout = '7s'",
      'LOCK TABLE token_prices IN SHARE ROW EXCLUSIVE MODE'
    ])
    expect(statements.at(-1)).toBe('COMMIT')
    expect(statements.filter((statement) => statement.startsWith('SELECT DISTINCT ON'))).toHaveLength(1)
  })

  it('performs no network work inside the transaction', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await finalizeBackfillTargets(backfillPool(), [target()])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('concurrency against insertTokenPrices', () => {
  it('waits for an in-flight insert, then reports the committed row', async () => {
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query(
      `INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
       VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7)`,
      [CHAIN, TOKEN, EOD, 4.25, 'USDC', 0.5, 'curve']
    )

    await expect(
      finalizeBackfillTargets(backfillPool(), [target()], { lockTimeout: '150ms', lockRetryLimit: 1 })
    ).rejects.toBeInstanceOf(FinalizationLockError)

    await blocker.query('COMMIT')
    blocker.release()

    const outcome = await finalizeBackfillTargets(backfillPool(), [target()], { lockTimeout: '2s' })
    expect(outcome.results[0].status).toBe('skipped_concurrent_existing')

    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('curve')
  })

  it('leaves an insertTokenPrices write untouched after the batch commits', async () => {
    await insertTokenPrices(neonPool(), [
      {
        chain: CHAIN,
        token: TOKEN,
        timestamp: EOD - 86_400,
        price: 7,
        symbol: 'USDC',
        confidence: null,
        source: 'curve'
      }
    ])

    await finalizeBackfillTargets(backfillPool(), [target()])

    const rows = await priceRows()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.source).sort()).toEqual(['curve', 'defillama'])
  })
})

describe('lock failures', () => {
  it('retries within the bounded limit, then fails visibly without an inventory row', async () => {
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE token_prices IN ACCESS EXCLUSIVE MODE')

    try {
      await expect(
        finalizeBackfillTargets(backfillPool(), [target({ resolution: null })], {
          lockTimeout: '100ms',
          lockRetryLimit: 2
        })
      ).rejects.toMatchObject({ name: 'FinalizationLockError', attempts: 3 })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }

    expect(await inventoryRows()).toEqual([])
    expect(await priceRows()).toEqual([])
  })
})

describe('transaction atomicity', () => {
  it('rolls back the insert when the inventory sync fails', async () => {
    const failing: BackfillClientPool = {
      connect: async () => {
        const client = (await pool.connect()) as unknown as BackfillClient
        return {
          query: (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO historical_price_gap_inventory')) {
              return Promise.reject(new Error('inventory sync failed'))
            }
            return client.query(sql, params)
          },
          release: () => client.release()
        }
      }
    }

    await expect(
      finalizeBackfillTargets(failing, [target(), target({ eodTimestamp: EOD - 86_400, resolution: null })])
    ).rejects.toThrow('inventory sync failed')

    expect(await priceRows()).toEqual([])
    expect(await inventoryRows()).toEqual([])
  })
})

describe('inventory lifecycle', () => {
  it('upserts one row per unresolved target and stays idempotent across reruns', async () => {
    await finalizeBackfillTargets(backfillPool(), [target({ resolution: null })])
    await finalizeBackfillTargets(backfillPool(), [target({ resolution: null })])

    const rows = await inventoryRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].token).toBe(TOKEN_LOWERCASE)
    expect(Number(rows[0].chain_id)).toBe(CHAIN_ID)
    expect(Math.floor(rows[0].timestamp.getTime() / 1000)).toBe(EOD)
  })

  it('deletes the inventory row once the target is inserted', async () => {
    await finalizeBackfillTargets(backfillPool(), [target({ resolution: null })])
    expect(await inventoryRows()).toHaveLength(1)

    await finalizeBackfillTargets(backfillPool(), [target()])
    expect(await inventoryRows()).toEqual([])
  })

  it('deletes a stale inventory row when the target is priced concurrently', async () => {
    await finalizeBackfillTargets(backfillPool(), [target({ resolution: null })])
    await seedPrice('enso', 8)

    const outcome = await finalizeBackfillTargets(backfillPool(), [target()])
    expect(outcome.results[0].status).toBe('skipped_concurrent_existing')
    expect(await inventoryRows()).toEqual([])
  })
})

describe('dry run', () => {
  it('classifies targets without writing prices or inventory rows', async () => {
    await seedPrice('curve', 3, EOD - 86_400)

    const outcome = await finalizeBackfillTargets(
      backfillPool(),
      [target(), target({ eodTimestamp: EOD - 86_400 }), target({ eodTimestamp: EOD - 172_800, resolution: null })],
      { dryRun: true }
    )

    expect(outcome.inserted).toBe(1)
    expect(outcome.skippedConcurrentExisting).toBe(1)
    expect(outcome.unresolved).toBe(1)

    const rows = await priceRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('curve')
    expect(await inventoryRows()).toEqual([])
  })
})
