import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { EnsoClient } from '../src/enso'
import { handleSpot } from '../src/routes/prices'
import { toUnixSeconds } from '../src/time'
import type { Env, SpotResponseCoin } from '../src/types'

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
    NETWORK_TIMEOUT
  )

  it(
    'proxies a live WETH spot price through handleSpot (stateless, no DB write)',
    async () => {
      const env: Env = { DATABASE_URL: 'postgres://unused', ENSO_API_KEY }

      const coinKey = `ethereum:${WETH}`
      const request = new Request(`https://svc/api/prices/spot?coins=${encodeURIComponent(JSON.stringify([coinKey]))}`)
      const response = await handleSpot(request, env)

      expect(response.status).toBe(200)
      const body = (await response.json()) as { coins: Record<string, SpotResponseCoin> }
      const coin = body.coins[coinKey]
      if (!('prices' in coin)) {
        throw new Error('expected success coin')
      }
      const price = coin.prices[0]
      expect(price.price).toBeGreaterThan(0)
      expect(price.source).toBe('enso')
      // Live spot timestamp: Enso ms converted to seconds, near now (not normalized to a day-end).
      // (Would be a far-future value if the ms→seconds conversion regressed.)
      expect(price.timestamp).toBeGreaterThan(1_700_000_000)
      expect(price.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60)
    },
    NETWORK_TIMEOUT
  )
})
