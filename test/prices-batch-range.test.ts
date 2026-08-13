import { describe, expect, it, vi } from 'vitest'
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_PARTIAL, CACHE_CONTROL_TODAY } from '../src/cache'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleRangeHistorical } from '../src/routes/historical/range'
import type { Env } from '../src/types'
import { normalizeToEndOfDay } from '../src/utils'

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM_ADDR = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const CHECKSUM_KEY = `Ethereum:${CHECKSUM_ADDR}`
const ENV: Env = { DATABASE_URL: 'postgres://x' }
const DAY_ONE = 1695254399
const DAY_TWO = 1695340799
const TODAY = normalizeToEndOfDay(Math.floor(Date.now() / 1000))

function url(path: string, coins: unknown, extra = '') {
  return new Request(`https://svc/api/prices/${path}?coins=${encodeURIComponent(JSON.stringify(coins))}${extra}`)
}

function row(timestamp: number, price: string, source = 'defillama') {
  return {
    chain: 'ethereum',
    token: CHECKSUM_ADDR,
    timestamp: new Date(timestamp * 1000),
    price,
    symbol: 'WETH',
    confidence: '0.9',
    source
  }
}

function pool(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })) } as any
}

describe('handleBatchHistorical', () => {
  it('groups rows under the caller original token key and sorts by timestamp', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [CHECKSUM_KEY]: [DAY_TWO, DAY_ONE] }),
      ENV,
      pool([row(DAY_TWO, '2'), row(DAY_ONE, '1')])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [
            { timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' },
            { timestamp: DAY_TWO, price: 2, confidence: 0.9, source: 'defillama' }
          ]
        }
      }
    })
  })

  it('marks a fully resolved past batch immutable', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('marks an incomplete past batch partial', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('marks a batch touching today with the short-lived policy', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY] }),
      ENV,
      pool([row(TODAY, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('passes an explicit source through to the query', async () => {
    const queryPool = pool([row(DAY_ONE, '1', 'enso')])
    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=enso'),
      ENV,
      queryPool
    )

    expect(queryPool.query.mock.calls[0][1]).toContain('enso')
  })

  it('rejects an unsupported source', async () => {
    await expect(
      handleBatchHistorical(
        url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=nope'),
        ENV,
        pool([])
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('handleRangeHistorical', () => {
  it('groups a range under the caller original token key', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [CHECKSUM_KEY]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1'), row(DAY_TWO, '2')])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      coins: {
        [CHECKSUM_KEY]: {
          symbol: 'WETH',
          prices: [
            { timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' },
            { timestamp: DAY_TWO, price: 2, confidence: 0.9, source: 'defillama' }
          ]
        }
      }
    })
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_IMMUTABLE)
  })

  it('marks a range with a missing day partial', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('marks a range ending today with the short-lived policy', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY, TODAY] }),
      ENV,
      pool([row(TODAY, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('rejects a reversed range', async () => {
    await expect(
      handleRangeHistorical(url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_TWO, DAY_ONE] }), ENV, pool([]))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
