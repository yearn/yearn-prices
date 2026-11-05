import type { Pool } from '@neondatabase/serverless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_CONTROL_HISTORICAL,
  CACHE_CONTROL_NO_STORE,
  CACHE_CONTROL_PARTIAL,
  CACHE_CONTROL_TODAY
} from '../src/cache'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleRangeHistorical } from '../src/routes/historical/range'
import { MAX_READ_THROUGH_TARGETS, type ReadThroughUpstream } from '../src/routes/historical/read-through'
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

const CURRENT_KEY = `ethereum:${RAW_ADDR}`

const LIVE = { price: 2425.5, timestamp: Math.floor(Date.now() / 1000) - 20, symbol: 'WETH', confidence: 0.99 }

type Mocked = ReadThroughUpstream & { current: ReturnType<typeof vi.fn>; historical: ReturnType<typeof vi.fn> }

function upstreamOf(overrides: Partial<ReadThroughUpstream> = {}): Mocked {
  return {
    current: vi.fn(async () => new Map()),
    historical: vi.fn(async () => ({ prices: [], failed: false })),
    ...overrides
  } as Mocked
}

function currentLive() {
  return vi.fn(async () => new Map([[CURRENT_KEY, LIVE]]))
}

function closedAt(price = 1800.25) {
  return vi.fn(async (targets: Array<{ chainId: number; token: string; timestamp: number }>) => ({
    prices: targets.map((target) => ({
      target,
      price: { price, timestamp: target.timestamp - 3_600, symbol: 'WETH', confidence: 0.97 }
    })),
    failed: false
  }))
}

function inserts(queryPool: Pool) {
  return vi.mocked(queryPool.query).mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO token_prices'))
}

function pool(rows: unknown[]): Pool {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as Pool
}

describe('handleBatchHistorical', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

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

  it('requires revalidation for a fully resolved past batch', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }),
      ENV,
      pool([row(DAY_ONE, '1')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_HISTORICAL)
  })

  it('marks an incomplete past batch partial', async () => {
    const queryPool = pool([row(DAY_ONE, '1')])
    const upstream = upstreamOf()

    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      queryPool,
      upstream
    )

    expect(response.headers.get('cache-control')).toBe('public, s-maxage=300, max-age=300')
    await expect(response.json()).resolves.toEqual({
      coins: {
        [`ethereum:${RAW_ADDR}`]: {
          symbol: 'WETH',
          prices: [{ timestamp: DAY_ONE, price: 1, confidence: 0.9, source: 'defillama' }]
        }
      }
    })
    const insertCall = (queryPool.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO token_prices')
    )
    expect(insertCall).toBeUndefined()
    expect(upstream.historical).toHaveBeenCalledTimes(1)
    expect(upstream.historical.mock.calls[0][0]).toEqual([{ chainId: 1, token: CHECKSUM_ADDR, timestamp: DAY_TWO }])
  })

  it('rejects duplicate normalized token keys even when their requested days differ', async () => {
    await expect(
      handleBatchHistorical(
        url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE], [CHECKSUM_KEY]: [DAY_TWO] }),
        ENV,
        pool([])
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('uses the mutable policy for a batch touching a future day', async () => {
    const future = TODAY + 86400
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, future] }),
      ENV,
      pool([row(DAY_ONE, '1'), row(future, '2')])
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('marks a batch touching today with the short-lived policy', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY] }),
      ENV,
      pool([row(TODAY, '1')]),
      upstreamOf()
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('fills only the missing closed day and replaces today live, in one call per stage', async () => {
    const upstream = upstreamOf({ current: currentLive(), historical: closedAt() })
    const queryPool = pool([row(DAY_ONE, '1'), row(TODAY, '5')])
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO, TODAY] }),
      ENV,
      queryPool,
      upstream
    )

    expect(upstream.historical).toHaveBeenCalledTimes(1)
    expect(upstream.historical.mock.calls[0][0]).toEqual([{ chainId: 1, token: CHECKSUM_ADDR, timestamp: DAY_TWO }])
    expect(upstream.current).toHaveBeenCalledTimes(1)
    expect(upstream.current.mock.calls[0][0]).toEqual([{ chain: 'ethereum', token: CHECKSUM_ADDR }])
    const written = inserts(queryPool).map(([, params]) => params as unknown[])
    expect(written).toHaveLength(2)
    expect(written.some((params) => params.includes('/prices/current') && params.includes(false))).toBe(true)
    expect(written.some((params) => params.includes('/batchHistorical') && params.includes(true))).toBe(true)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
    await expect(response.json()).resolves.toMatchObject({
      coins: {
        [`ethereum:${RAW_ADDR}`]: {
          prices: [
            { timestamp: DAY_ONE, price: 1 },
            { timestamp: DAY_TWO, price: 1800.25, source: 'defillama' },
            { timestamp: TODAY, price: 2425.5, source: 'defillama' }
          ]
        }
      }
    })
  })

  it('appends a missing today row from the live call', async () => {
    const queryPool = pool([row(DAY_ONE, '1')])
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, TODAY] }),
      ENV,
      queryPool,
      upstreamOf({ current: currentLive() })
    )

    expect(inserts(queryPool)).toHaveLength(1)
    await expect(response.json()).resolves.toMatchObject({
      coins: { [`ethereum:${RAW_ADDR}`]: { prices: [{ timestamp: DAY_ONE }, { timestamp: TODAY, price: 2425.5 }] } }
    })
  })

  it('uses no-store when upstream failed and the batch is unresolved, but not when everything resolved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      upstreamOf({ historical: vi.fn(async () => ({ prices: [], failed: true })) })
    )
    expect(failed.headers.get('cache-control')).toBe(CACHE_CONTROL_NO_STORE)

    const resolved = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY] }),
      ENV,
      pool([row(TODAY, '1')]),
      upstreamOf({
        current: vi.fn(async () => {
          throw new Error('429')
        })
      })
    )
    expect(resolved.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
    await expect(resolved.json()).resolves.toMatchObject({
      coins: { [`ethereum:${RAW_ADDR}`]: { prices: [{ timestamp: TODAY, price: 1 }] } }
    })
  })

  it('does not call upstream for closed days in the table or an explicit source', async () => {
    const upstream = upstreamOf({ current: currentLive(), historical: closedAt() })
    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      upstream
    )
    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, TODAY] }, '&source=defillama'),
      ENV,
      pool([]),
      upstream
    )

    expect(upstream.current).not.toHaveBeenCalled()
    expect(upstream.historical).not.toHaveBeenCalled()
  })

  it('passes an explicit source through to the query', async () => {
    const queryPool = pool([row(DAY_ONE, '1', 'enso')])
    await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=enso'),
      ENV,
      queryPool
    )

    expect(vi.mocked(queryPool.query).mock.calls[0][1]).toContain('enso')
  })

  it('returns an empty batch for a live-only source instead of failing', async () => {
    const response = await handleBatchHistorical(
      url('batchHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE] }, '&source=chainlink'),
      ENV,
      pool([])
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ coins: {} })
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
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_HISTORICAL)
  })

  it('marks a range with a missing day partial', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      upstreamOf()
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('marks a range ending today with the short-lived policy', async () => {
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY, TODAY] }),
      ENV,
      pool([row(TODAY, '1')]),
      upstreamOf()
    )

    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_TODAY)
  })

  it('fills missing days inside a range and persists them as finalized', async () => {
    const upstream = upstreamOf({ historical: closedAt() })
    const queryPool = pool([row(DAY_ONE, '1')])
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_ONE + 2 * 86_400] }),
      ENV,
      queryPool,
      upstream
    )

    expect(upstream.historical.mock.calls[0][0]).toEqual([
      { chainId: 1, token: CHECKSUM_ADDR, timestamp: DAY_ONE + 86_400 },
      { chainId: 1, token: CHECKSUM_ADDR, timestamp: DAY_ONE + 2 * 86_400 }
    ])
    expect(inserts(queryPool)).toHaveLength(1)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_HISTORICAL)
    await expect(response.json()).resolves.toMatchObject({
      coins: {
        [`ethereum:${RAW_ADDR}`]: {
          prices: [
            { timestamp: DAY_ONE, price: 1 },
            { timestamp: DAY_ONE + 86_400, price: 1800.25 },
            { timestamp: DAY_ONE + 2 * 86_400, price: 1800.25 }
          ]
        }
      }
    })
  })

  it('caps closed-day read-through targets per request', async () => {
    const upstream = upstreamOf({ historical: closedAt() })
    const response = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_ONE + 249 * 86_400] }),
      ENV,
      pool([]),
      upstream
    )

    expect(MAX_READ_THROUGH_TARGETS).toBe(200)
    expect(upstream.historical.mock.calls[0][0]).toHaveLength(200)
    const body = (await response.json()) as { coins: Record<string, { prices: unknown[] }> }
    expect(body.coins[`ethereum:${RAW_ADDR}`].prices).toHaveLength(200)
    expect(response.headers.get('cache-control')).toBe(CACHE_CONTROL_PARTIAL)
  })

  it('replaces today live in a range and uses no-store when upstream failed with days unresolved', async () => {
    const live = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY, TODAY] }),
      ENV,
      pool([row(TODAY, '5')]),
      upstreamOf({ current: currentLive() })
    )
    await expect(live.json()).resolves.toMatchObject({
      coins: { [`ethereum:${RAW_ADDR}`]: { prices: [{ timestamp: TODAY, price: 2425.5 }] } }
    })

    const failed = await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1')]),
      upstreamOf({ historical: vi.fn(async () => ({ prices: [], failed: true })) })
    )
    expect(failed.headers.get('cache-control')).toBe(CACHE_CONTROL_NO_STORE)
  })

  it('does not call upstream for a range of closed days in the table', async () => {
    const upstream = upstreamOf({ current: currentLive(), historical: closedAt() })
    await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_ONE, DAY_TWO] }),
      ENV,
      pool([row(DAY_ONE, '1'), row(DAY_TWO, '2')]),
      upstream
    )
    await handleRangeHistorical(
      url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [TODAY - 86_400, TODAY] }, '&source=defillama'),
      ENV,
      pool([]),
      upstream
    )

    expect(upstream.current).not.toHaveBeenCalled()
    expect(upstream.historical).not.toHaveBeenCalled()
  })

  it('rejects a reversed range', async () => {
    await expect(
      handleRangeHistorical(url('rangeHistorical', { [`ethereum:${RAW_ADDR}`]: [DAY_TWO, DAY_ONE] }), ENV, pool([]))
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
