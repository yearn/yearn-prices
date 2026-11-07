import { expect, it } from 'vitest'
import { getUnfinalizedExactTimestamps, type QueryExecutor } from '../../src/db/queries'
import { driverQuery } from '../helpers/drizzle-driver'

it('finds source-specific provisional rows without applying the finalized read filter', async () => {
  let sql = ''
  const pool: QueryExecutor = {
    query: driverQuery(async (text) => {
      sql = text
      return {
        rows: [{ chain: 'ethereum', token: '0xabc', timestamp: new Date('2025-08-16T23:59:59.000Z') }]
      }
    })
  }

  const rows = await getUnfinalizedExactTimestamps(
    pool,
    [{ chain: 'ethereum', token: '0xabc', timestamp: 1_755_388_799 }],
    'defillama'
  )

  expect(rows).toEqual(new Set(['ethereum:0xabc:1755388799']))
  expect(sql).toMatch(/tp\.finalized = \$\d+/)
  expect(sql).toContain('rejected_price_observations')
  expect(sql).not.toContain('tp.finalized = TRUE')
})
