import { expect, it, vi } from 'vitest'
import { repairCurveLpOutlier } from '../../scripts/lib/repair-curve-lp'
import type { Queryable, QueryExecutor } from '../../src/db/queries'
import { REJECTED_OBSERVATIONS } from '../../src/prices/rejections'
import type { ResolvedPricePath } from '../../src/sources/onchain/types'

const target = REJECTED_OBSERVATIONS[0]
function fakePool() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('RETURNING id') ? [{ id: 1 }] : [], rowCount: 0 }))
  return { query, pool: { query } as unknown as Queryable & QueryExecutor }
}

it('commits quarantine before attempting a replacement and reports an RPC failure', async () => {
  const { query, pool } = fakePool()
  const result = await repairCurveLpOutlier(pool, target, true, async () => {
    expect(query.mock.calls[0][0]).toContain('INSERT INTO quarantined_token_prices')
    throw new Error('archive RPC unavailable')
  })
  expect(result).toMatchObject({ status: 'unresolved', quarantined: 1, reason: 'archive RPC unavailable' })
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO token_prices'))).toBe(false)
})

it('retries a replacement even when there is no provider row left', async () => {
  const { query, pool } = fakePool()
  const path = {
    chainId: 1,
    token: target.token,
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
  query.mockResolvedValue({ rows: [], rowCount: 0 })
  const result = await repairCurveLpOutlier(pool, target, true, async () => path)
  expect(result).toMatchObject({ status: 'derived', quarantined: 0, path })
  expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO token_prices'))).toBe(true)
})

it('does not quarantine or write in dry-run mode', async () => {
  const { query, pool } = fakePool()
  await repairCurveLpOutlier(pool, target, false, async () => null)
  expect(query.mock.calls.every(([sql]) => !/DELETE|INSERT/.test(sql))).toBe(true)
})
