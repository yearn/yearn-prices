import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Pool as PgPool } from 'pg'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { finalizeTokenPrices, getBatchHistoricalPrices, insertProvisionalTokenPrices } from '../../src/db/queries'
import { handleHistorical } from '../../src/routes/historical/exact'
import type { Env, TokenPriceWrite } from '../../src/types'
import { currentUtcDayEnd, normalizeToEndOfDay, nowUnix } from '../../src/utils/time'

const RAW_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const TOKEN_KEY = `ethereum:${RAW_ADDR}`
const ENV = {} as Env

let pool: PgPool
let fetchMock: ReturnType<typeof vi.fn>

function neonPool(): NeonPool {
  return pool as unknown as NeonPool
}

function request(): Request {
  return new Request(`https://svc/api/prices/historical/0/${TOKEN_KEY}`)
}

async function seedPrice(timestamp: number, price: number): Promise<void> {
  await pool.query(
    `INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
     VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7)`,
    ['ethereum', getAddress(RAW_ADDR), timestamp, price, 'WETH', 0.99, 'defillama']
  )
}

beforeEach(() => {
  pool ??= new PgPool({ connectionString: inject('databaseUrl'), max: 4 })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await pool.query('TRUNCATE token_prices')
})

afterAll(async () => {
  await pool.end()
})

describe('current-day historical lookups (incident regression)', () => {
  it.each(['0', '-1', 'NaN', 'Infinity', '-Infinity'])('rejects invalid stored price %s', async (price) => {
    await expect(
      pool.query(
        `INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source)
         VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7)`,
        ['ethereum', getAddress(RAW_ADDR), nowUnix(), price, 'WETH', null, 'defillama']
      )
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('returns NOT_FOUND for a current-day block with no stored row after one empty DeFiLlama call', async () => {
    const blockTime = nowUnix() - 600
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ coins: {} }), { status: 200 }))

    await expect(handleHistorical(request(), ENV, neonPool(), String(blockTime), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://coins.llama.fi/prices/historical/')
  })

  it('serves a past-day block from the end-of-day keyed row without any upstream call', async () => {
    const yesterdayNoon = nowUnix() - 86_400
    await seedPrice(normalizeToEndOfDay(yesterdayNoon), 3400.25)

    const response = await handleHistorical(request(), ENV, neonPool(), String(yesterdayNoon), TOKEN_KEY)

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      coins: { [TOKEN_KEY]: { price: 3400.25 } }
    })
  })

  it('serves a current-day block from a warmed end-of-day row without any upstream call', async () => {
    const blockTime = nowUnix() - 60
    await seedPrice(normalizeToEndOfDay(blockTime), 3419.75)

    const response = await handleHistorical(request(), ENV, neonPool(), String(blockTime), TOKEN_KEY)

    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      coins: { [TOKEN_KEY]: { price: 3419.75 } }
    })
  })

  it('finalizes a provisional close on a later run after midnight and keeps it immutable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-03T23:59:00.000Z'))
    const closingTimestamp = currentUtcDayEnd()
    const provisional: TokenPriceWrite = {
      chain: 'ethereum',
      token: getAddress(RAW_ADDR),
      timestamp: closingTimestamp,
      price: 10,
      symbol: 'WETH',
      confidence: null,
      source: 'defillama',
      observedTimestamp: nowUnix(),
      observationEndpoint: '/batchHistorical',
      finalizationIntent: 'provisional'
    }

    try {
      // The fetch was planned just before midnight but its queued write settles
      // after midnight; preserve the request-time intent instead of finalizing it.
      vi.setSystemTime(new Date('2026-11-04T00:01:00.000Z'))
      await insertProvisionalTokenPrices(pool as unknown as NeonPool, [provisional])
      const provisionalRow = await pool.query(
        'SELECT finalized, price FROM token_prices WHERE timestamp = to_timestamp($1)',
        [closingTimestamp]
      )
      expect(provisionalRow.rows[0]).toMatchObject({ finalized: false, price: '10' })

      // Simulate a failed last hourly run: no close write happens before midnight.
      vi.setSystemTime(new Date('2026-11-04T00:05:00.000Z'))
      await finalizeTokenPrices(pool as unknown as NeonPool, [
        { ...provisional, price: 12, observedTimestamp: closingTimestamp - 30 }
      ])
      await finalizeTokenPrices(pool as unknown as NeonPool, [
        { ...provisional, price: 99, observedTimestamp: closingTimestamp }
      ])

      const finalized = await pool.query(
        'SELECT finalized, price, observed_at, observation_endpoint FROM token_prices WHERE timestamp = to_timestamp($1)',
        [closingTimestamp]
      )
      expect(finalized.rows[0]).toMatchObject({
        finalized: true,
        price: '12',
        observation_endpoint: '/batchHistorical'
      })
      expect(Math.floor(new Date(finalized.rows[0].observed_at).getTime() / 1000)).toBe(closingTimestamp - 30)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps serving the day that just closed before warmup finalizes it', async () => {
    const timestamp = currentUtcDayEnd() - 86_400
    const write: TokenPriceWrite = {
      chain: 'ethereum',
      token: getAddress(RAW_ADDR),
      timestamp,
      price: 10,
      symbol: 'WETH',
      confidence: null,
      source: 'defillama',
      finalizationIntent: 'provisional'
    }
    await insertProvisionalTokenPrices(pool as unknown as NeonPool, [write])
    const target = { chain: write.chain, token: write.token, timestamp }
    expect(await getBatchHistoricalPrices(neonPool(), [target], 'defillama')).toMatchObject([{ price: 10 }])
  })

  it('does not count an unfinalized closed row as source-filtered historical coverage', async () => {
    const timestamp = 1_755_388_799
    const write: TokenPriceWrite = {
      chain: 'ethereum',
      token: getAddress(RAW_ADDR),
      timestamp,
      price: 10,
      symbol: 'WETH',
      confidence: null,
      source: 'defillama',
      finalizationIntent: 'provisional'
    }
    const target = { chain: write.chain, token: write.token, timestamp }

    await insertProvisionalTokenPrices(pool as unknown as NeonPool, [write])
    expect(await getBatchHistoricalPrices(neonPool(), [target], 'defillama')).toEqual([])

    await finalizeTokenPrices(pool as unknown as NeonPool, [{ ...write, price: 11 }])
    expect(await getBatchHistoricalPrices(neonPool(), [target], 'defillama')).toMatchObject([{ price: 11 }])
  })
})
