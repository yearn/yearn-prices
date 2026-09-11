import type { Pool as NeonPool } from '@neondatabase/serverless'
import { Pool as PgPool } from 'pg'
import { getAddress } from 'viem'
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { handleHistorical } from '../../src/routes/historical/exact'
import type { Env } from '../../src/types'
import { normalizeToEndOfDay, nowUnix } from '../../src/utils/time'

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
  it('returns NOT_FOUND for a current-day block with no stored row, without any upstream call', async () => {
    const blockTime = nowUnix() - 600

    await expect(handleHistorical(request(), ENV, neonPool(), String(blockTime), TOKEN_KEY)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })

    expect(fetchMock).not.toHaveBeenCalled()
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
})
