import { describe, expect, it, vi } from 'vitest'
import type { Pool } from '@neondatabase/serverless'
import { BAD_DEFILLAMA_TOKEN_KEYS } from '../src/bad-defillama-tokens'
import { getBatchHistoricalPrices, getRangeHistoricalPrices } from '../src/queries'
import { normalizeToEndOfDay, unixToIsoTimestamp } from '../src/time'
import type { DbPriceRow } from '../src/types'

const Y_POOL = '0xdF5e0e81Dff6FAF3A7e52BA697820c5e32D806A8'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TS = normalizeToEndOfDay(1_700_000_000)

function dbRow(overrides: Partial<DbPriceRow> & Pick<DbPriceRow, 'token' | 'source' | 'price'>): DbPriceRow {
  return {
    chain: 'ethereum',
    timestamp: new Date(TS * 1000),
    symbol: null,
    confidence: null,
    ...overrides,
  }
}

function mockPool(rows: DbPriceRow[] = []) {
  const query = vi.fn(async () => ({ rows }))
  return { pool: { query } as unknown as Pool, query }
}

describe('query denylist filter', () => {
  it('batch reads exclude denylisted DefiLlama rows in SQL (with and without source)', async () => {
    const { pool, query } = mockPool([])
    const request = { chain: 'ethereum', token: Y_POOL, timestamp: TS }

    await getBatchHistoricalPrices(pool, [request])
    await getBatchHistoricalPrices(pool, [request], 'defillama')
    await getBatchHistoricalPrices(pool, [request], 'curve')

    expect(query).toHaveBeenCalledTimes(3)
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("source = 'defillama'")
      expect(sql).toContain(Y_POOL)
      for (const key of BAD_DEFILLAMA_TOKEN_KEYS) {
        const token = key.slice(key.indexOf(':') + 1)
        expect(sql).toContain(token)
      }
    }

    // Explicit source is parameterized; denylist still ANDed in.
    const [, defillamaParams] = query.mock.calls[1]
    expect(defillamaParams).toContain('defillama')
    const [, curveParams] = query.mock.calls[2]
    expect(curveParams).toContain('curve')
  })

  it('range reads exclude denylisted DefiLlama rows in SQL (with and without source)', async () => {
    const { pool, query } = mockPool([])
    const request = {
      chain: 'ethereum',
      token: Y_POOL,
      startTimestamp: TS - 86_400,
      endTimestamp: TS,
    }

    await getRangeHistoricalPrices(pool, [request])
    await getRangeHistoricalPrices(pool, [request], 'defillama')
    await getRangeHistoricalPrices(pool, [request], 'curve')

    expect(query).toHaveBeenCalledTimes(3)
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("source = 'defillama'")
      expect(sql).toContain(Y_POOL)
    }
  })

  it('batch without source returns Curve for denylisted LPs and DefiLlama for normal tokens', async () => {
    // Simulates DISTINCT ON + SOURCE_PRIORITY after the denylist filter has already
    // dropped the bad DefiLlama Y-pool row; USDC still wins via DefiLlama.
    const { pool, query } = mockPool([
      dbRow({ token: Y_POOL, source: 'curve', price: '1.02', confidence: null, symbol: 'yCRV' }),
      dbRow({ token: USDC, source: 'defillama', price: '1', confidence: '0.99', symbol: 'USDC' }),
    ])

    const rows = await getBatchHistoricalPrices(pool, [
      { chain: 'ethereum', token: Y_POOL, timestamp: TS },
      { chain: 'ethereum', token: USDC, timestamp: TS },
    ])

    expect(query).toHaveBeenCalledOnce()
    const [sql] = query.mock.calls[0]
    expect(sql).toContain('DISTINCT ON')
    expect(sql).toMatch(/CASE tp\.source[\s\S]*WHEN 'defillama' THEN 1/)
    expect(sql).toMatch(/WHEN 'curve' THEN 4/)

    expect(rows).toEqual([
      {
        chain: 'ethereum',
        token: Y_POOL,
        timestamp: TS,
        price: 1.02,
        symbol: 'yCRV',
        confidence: null,
        source: 'curve',
      },
      {
        chain: 'ethereum',
        token: USDC,
        timestamp: TS,
        price: 1,
        symbol: 'USDC',
        confidence: 0.99,
        source: 'defillama',
      },
    ])
  })

  it('batch with source=curve still returns Curve rows for denylisted LPs', async () => {
    const { pool, query } = mockPool([
      dbRow({ token: Y_POOL, source: 'curve', price: '1.02', confidence: null }),
    ])

    const rows = await getBatchHistoricalPrices(
      pool,
      [{ chain: 'ethereum', token: Y_POOL, timestamp: TS }],
      'curve',
    )

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('tp.source = $')
    expect(params).toContain('curve')
    expect(params).toContain(unixToIsoTimestamp(TS))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ token: Y_POOL, source: 'curve', price: 1.02, confidence: null })
  })

  it('range without source preserves SOURCE_PRIORITY ordering expression', async () => {
    const { pool, query } = mockPool([])

    await getRangeHistoricalPrices(pool, [{
      chain: 'ethereum',
      token: USDC,
      startTimestamp: TS - 86_400,
      endTimestamp: TS,
    }])

    const [sql] = query.mock.calls[0]
    expect(sql).toContain('DISTINCT ON')
    expect(sql).toMatch(/WHEN 'defillama' THEN 1/)
    expect(sql).toMatch(/WHEN 'curve' THEN 4/)
    expect(sql).toMatch(/WHEN 'derived' THEN 5/)
  })
})
