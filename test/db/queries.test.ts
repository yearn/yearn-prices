import type { Pool } from '@neondatabase/serverless'
import { describe, expect, it, vi } from 'vitest'
import { getBatchHistoricalPrices, getRangeHistoricalPrices } from '../../src/db/queries'

function capturingPool(): { pool: Pool; sql: () => string } {
  const query = vi.fn(async () => ({ rows: [] }))
  return { pool: { query } as unknown as Pool, sql: () => String(query.mock.calls[0]?.[0] ?? '') }
}

const REQUEST = { chain: 'ethereum', token: '0xabc', timestamp: 1_700_000_000 }

describe('historical price queries', () => {
  it.each([
    ['any source', undefined],
    ['a single source', 'defillama' as const]
  ])('never returns a non-positive price for %s', async (_label, source) => {
    const exact = capturingPool()
    await getBatchHistoricalPrices(exact.pool, [REQUEST], source)
    expect(exact.sql()).toContain('tp.price > 0')

    const range = capturingPool()
    await getRangeHistoricalPrices(
      range.pool,
      [{ chain: REQUEST.chain, token: REQUEST.token, startTimestamp: 1, endTimestamp: 2 }],
      source
    )
    expect(range.sql()).toContain('tp.price > 0')
  })
})
