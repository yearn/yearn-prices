import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { EnsoClient } from '../src/enso'
import { handleCurrent } from '../src/routes/prices'
import { currentUtcDayEnd, toUnixSeconds, unixToIsoTimestamp } from '../src/time'
import type { Env } from '../src/types'

// Real key, loaded from .env via dotenv (vitest setupFiles). These tests hit the live Enso API,
// so they are gated: they run only when ENSO_API_KEY is set, and skip in CI / when it is absent.
const ENSO_API_KEY = process.env.ENSO_API_KEY
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const WETH_CHECKSUM = getAddress(WETH)
const NETWORK_TIMEOUT = 20_000

describe.skipIf(!ENSO_API_KEY)('Enso integration (live API)', () => {
  it(
    'fetches a live WETH price (Enso returns millisecond timestamps)',
    async () => {
      const data = await new EnsoClient(ENSO_API_KEY as string).getPrice(1, WETH)

      expect(typeof data.price).toBe('number')
      expect(data.price).toBeGreaterThan(0)
      expect(data.chainId).toBe(1)
      expect(typeof data.decimals).toBe('number')
      expect(getAddress(data.address)).toBe(WETH_CHECKSUM)
      expect(typeof data.timestamp).toBe('number')
      // Live Enso returns unix MILLISECONDS (13-digit). toUnixSeconds must yield sane seconds.
      const seconds = toUnixSeconds(data.timestamp as number)
      expect(seconds).toBeGreaterThan(1_000_000_000) // after 2001
      expect(seconds).toBeLessThan(100_000_000_000) // before year ~5138 (i.e. not still in ms)
    },
    NETWORK_TIMEOUT,
  )

  it(
    'builds the normalized row passed to the DB from a live price (the step right before insert)',
    async () => {
      const env: Env = { DATABASE_URL: 'postgres://unused', ENSO_API_KEY }
      const calls: Array<[string, unknown[]]> = []
      const pool = {
        query: (sql: string, params: unknown[]) => {
          calls.push([sql, params])
          return Promise.resolve({ rows: [] })
        },
        end: () => Promise.resolve(),
      } as any

      const coinKey = `ethereum:${WETH}`
      const request = new Request(
        `https://svc/api/prices/current?coins=${encodeURIComponent(JSON.stringify([coinKey]))}`,
      )
      const response = await handleCurrent(request, env, pool)

      expect(response.status).toBe(200)
      const body = (await response.json()) as any
      const coin = body.coins[coinKey]
      const price = coin.prices[0]
      expect(price.price).toBeGreaterThan(0)
      expect(price.source).toBe('enso')
      // Live price is current → ms timestamp converted and normalized to today's UTC day-end.
      // (Would be a far-future day if the ms→seconds conversion regressed.)
      expect(price.timestamp).toBe(currentUtcDayEnd())

      // Assert the exact row that would be written to token_prices — before any real insert.
      expect(calls).toHaveLength(1)
      const [sql, params] = calls[0]
      expect(sql).toContain('INSERT INTO token_prices')
      expect(sql).toContain('ON CONFLICT (chain, token, timestamp, source)')
      expect(params[0]).toBe('ethereum') // chain (name from the token key)
      expect(params[1]).toBe(WETH_CHECKSUM) // token (checksummed in DB, lowercased only for Enso)
      expect(params[2]).toBe(unixToIsoTimestamp(currentUtcDayEnd())) // today's UTC day-end
      expect(params[3]).toBe(price.price) // price matches the proxied response
      expect(params[6]).toBe('enso') // source
    },
    NETWORK_TIMEOUT,
  )
})
