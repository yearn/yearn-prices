import { expect, it } from 'vitest'
import { getBatchHistoricalPrices } from '../../src/db/queries'

it('splits large exact reads below the Postgres bind parameter limit', async () => {
  const paramCounts: number[] = []
  const pool = {
    async query(_sql: string, params?: unknown[]) {
      paramCounts.push(params?.length ?? 0)
      return { rows: [] }
    }
  }
  const requests = Array.from({ length: 25_000 }, (_, index) => ({
    chain: 'optimism',
    token: `0x${index.toString(16).padStart(40, '0')}`,
    timestamp: 1792022399
  }))

  await getBatchHistoricalPrices(pool, requests, 'defillama')

  expect(paramCounts).toHaveLength(3)
  expect(Math.max(...paramCounts)).toBeLessThan(65_535)
})
