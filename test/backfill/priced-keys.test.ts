import { describe, expect, it } from 'vitest'
import { priceKey, readPricedKeys } from '../../src/backfill/priced-keys'
import type { QueryExecutor } from '../../src/db/queries'
import { pgTimestampToUnix } from '../../src/utils/time'

const EOD = 1_704_153_599

function target(token: string, chain = 'ethereum', eodTimestamp = EOD) {
  return { chain, token, eodTimestamp }
}

function fakePool(isPriced: (chain: string, token: string, timestamp: number) => boolean) {
  const calls: number[] = []
  const pool: QueryExecutor = {
    query: async (_sql: string, params: unknown[] = []) => {
      const rows: Record<string, unknown>[] = []
      let requestCount = 0
      for (let index = 0; index < params.length; index += 3) {
        requestCount += 1
        const chain = params[index] as string
        const token = params[index + 1] as string
        const timestamp = pgTimestampToUnix(params[index + 2] as string)
        if (isPriced(chain, token, timestamp)) {
          rows.push({
            chain,
            token,
            timestamp: new Date(timestamp * 1000),
            price: 1,
            symbol: null,
            confidence: null,
            source: 'defillama'
          })
        }
      }
      calls.push(requestCount)
      return { rows }
    }
  }
  return { pool, calls }
}

describe('readPricedKeys', () => {
  it('returns an empty set when no rows are returned', async () => {
    const { pool } = fakePool(() => false)

    const result = await readPricedKeys(pool, [target('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')], 10)

    expect(result).toEqual(new Set())
  })

  it('adds a key for every target when all are priced', async () => {
    const { pool } = fakePool(() => true)
    const targets = [
      target('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
      target('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1')
    ]

    const result = await readPricedKeys(pool, targets, 10)

    expect(result).toEqual(
      new Set([
        priceKey('ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', EOD),
        priceKey('ethereum', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', EOD)
      ])
    )
  })

  it('chunks targets and preserves every one across a non-exact chunk boundary', async () => {
    const { pool, calls } = fakePool(() => true)
    const targets = Array.from({ length: 5 }, (_, index) => target(`0x${(index + 1).toString().padStart(40, '0')}`))

    const result = await readPricedKeys(pool, targets, 2)

    expect(calls).toEqual([2, 2, 1])
    expect(result.size).toBe(5)
    for (const item of targets) {
      expect(result.has(priceKey(item.chain, item.token, item.eodTimestamp))).toBe(true)
    }
  })

  it('only includes the priced subset of the targets', async () => {
    const priced = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const unpriced = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
    const { pool } = fakePool((_chain, token) => token === priced)

    const result = await readPricedKeys(pool, [target(priced), target(unpriced)], 10)

    expect(result).toEqual(new Set([priceKey('ethereum', priced, EOD)]))
  })

  it('produces the chain:token:timestamp format used by the finalization lookup', () => {
    const chain = 'ethereum'
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    const timestamp = EOD

    expect(priceKey(chain, token, timestamp)).toBe(`${chain}:${token}:${timestamp}`)
  })
})
