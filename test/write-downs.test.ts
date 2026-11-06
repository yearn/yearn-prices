import type { Pool } from '@neondatabase/serverless'
import { describe, expect, it, vi } from 'vitest'
import { canonicalCacheKey, HISTORICAL_CACHE_REVISION } from '../src/cache/edge'
import * as rpc from '../src/clients/rpc'
import { loadWriteDowns, writeDown } from '../src/prices/write-downs'
import { spotSourceRegistry } from '../src/registries'
import { SpotSourceRegistry } from '../src/registries/spot'
import { handleBatchHistorical } from '../src/routes/historical/batch'
import { handleHistorical } from '../src/routes/historical/exact'
import { handleRangeHistorical } from '../src/routes/historical/range'
import { handleSpot } from '../src/routes/spot'
import { createCurveLpGuard } from '../src/sources/defillama/lp-guard'
import { fakeClient } from './sources/onchain/helpers'

const token = '0xc4c319e2d4d66cca4464c0c2b32c9bd23ebe784e'
const key = `ethereum:${token}`
const timestamp = 1690761599
const env = { DATABASE_URL: 'unused', ENSO_API_KEY: 'unused' }
const request = (path: string, coins?: unknown) =>
  new Request(`https://prices/api/prices/${path}${coins ? `?coins=${encodeURIComponent(JSON.stringify(coins))}` : ''}`)

describe('write-downs', () => {
  it('uses inclusive cutoffs, lowercase keys, and explicit source bypass', () => {
    expect(writeDown(1, token.toUpperCase(), 1690736855)?.price).toBe(0)
    expect(writeDown(1, token, 1690736854)).toBeNull()
    expect(writeDown(1, token, timestamp, 'enso')).toBeNull()
  })

  for (const route of ['spot', 'exact', 'batch', 'range']) {
    it(`serves ${route} without consulting storage or sources`, async () => {
      const query = vi.fn(() => {
        throw new Error('Unexpected table lookup')
      })
      const pool = { query } as unknown as Pool
      const registry = new SpotSourceRegistry([])
      const response =
        route === 'spot'
          ? await handleSpot(request('spot', [key]), env, registry)
          : route === 'exact'
            ? await handleHistorical(request('historical'), env, pool, String(timestamp), key)
            : route === 'batch'
              ? await handleBatchHistorical(request('batchHistorical', { [key]: [timestamp] }), env, pool)
              : await handleRangeHistorical(request('rangeHistorical', { [key]: [timestamp, timestamp] }), env, pool)
      const body = (await response.json()) as {
        coins: Record<string, { price?: number; source?: string; prices?: { price: number; source: string }[] }>
      }
      const price = body.coins[key].prices?.[0] ?? body.coins[key]
      expect(price).toMatchObject({ price: 0, source: 'write-down' })
      expect(query).not.toHaveBeenCalled()
    })
  }

  for (const route of ['exact', 'batch', 'range']) {
    for (const filtered of [false, true]) {
      it(`${route} preserves ${filtered ? 'explicit-source' : 'pre-cutoff'} lookup`, async () => {
        const time = filtered ? timestamp : 1690675199
        const query = vi.fn(async () => ({ rows: [] }))
        const pool = { query } as unknown as Pool
        const upstream = { current: async () => new Map(), historical: async () => ({ prices: [], failed: false }) }
        const req = request(route, { [key]: route === 'range' ? [time, time] : [time] })
        const url = new URL(req.url)
        if (filtered) url.searchParams.set('source', 'enso')
        const input = new Request(url)
        if (route === 'exact') {
          await expect(handleHistorical(input, env, pool, String(time), key, upstream)).rejects.toMatchObject({
            code: 'NOT_FOUND'
          })
        } else {
          const response =
            route === 'batch'
              ? await handleBatchHistorical(input, env, pool, upstream)
              : await handleRangeHistorical(input, env, pool, upstream)
          expect(await response.json()).toEqual({ coins: {} })
        }
        expect(query).toHaveBeenCalled()
      })
    }
  }

  it('revisions spot cache entries', () => {
    expect(new URL(canonicalCacheKey(request('spot', [key]).url)).searchParams.get('_price_cache_revision')).toBe(
      HISTORICAL_CACHE_REVISION
    )
  })

  it('rejects an implausible market quote through resolveSkipping', async () => {
    const registry = new SpotSourceRegistry(
      [
        {
          name: 'enso',
          priority: 10,
          supports: () => true,
          getSpotPrice: async () => ({ price: 5.7e20, timestamp, symbol: null, confidence: null })
        }
      ],
      async () => false
    )
    await expect(registry.resolveSkipping(undefined, 1, token)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it('spot serves write-downs for every source query', async () => {
  const url = new URL(request('spot', [key]).url)
  url.searchParams.set('source', 'enso')
  const response = await handleSpot(new Request(url), env, new SpotSourceRegistry([]))
  expect(await response.json()).toMatchObject({ coins: { [key]: { prices: [{ price: 0, source: 'write-down' }] } } })
})

const lpToken = '0x1111111111111111111111111111111111111111'
const lpKeyName = `ethereum:${lpToken}`

for (const scenario of ['empty', 'absurd', 'rpc-error']) {
  it(`spot Curve guard handles ${scenario}`, async () => {
    const guard = createCurveLpGuard({
      clientForChain: () =>
        fakeClient({
          [lpToken]: {
            N_COINS: 2n,
            coins: ['0x056fd409e1d7a124bd7017459dfea2f387b6d5cd', '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'],
            totalSupply: scenario === 'empty' ? 0n : 1n,
            get_virtual_price: 10n ** 18n
          }
        }),
      blockForTimestamp: async () => {
        if (scenario === 'rpc-error') throw new Error('rpc unavailable')
        return 1n
      },
      coinPrices: async () => [1, 1]
    })
    const registry = new SpotSourceRegistry(
      [
        {
          name: 'enso',
          priority: 10,
          supports: () => true,
          getSpotPrice: async () => ({ price: 5.7e20, timestamp, symbol: null, confidence: null })
        }
      ],
      guard
    )
    const response = await handleSpot(request('spot', [lpKeyName]), env, registry)
    const body = (await response.json()) as { coins: Record<string, unknown> }
    expect(body.coins[lpKeyName]).toMatchObject(
      scenario === 'rpc-error' ? { prices: [{ price: 5.7e20 }] } : { error: { code: 'NOT_FOUND' } }
    )
  })
}

it('chunks maximum range queries into exact timestamp lookups', async () => {
  const coins = Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [
      `ethereum:0x${(index + 1).toString(16).padStart(40, '0')}`,
      [timestamp - 365 * 86400, timestamp]
    ])
  )
  const query = vi.fn(async () => ({ rows: [] }))
  await handleRangeHistorical(request('rangeHistorical', coins), env, { query } as unknown as Pool, {
    current: async () => new Map(),
    historical: async () => ({ prices: [], failed: false })
  })
  expect((query.mock.calls[0] as unknown[])[1]).toHaveLength(30_000)
  expect((query.mock.calls[1] as unknown[])[1]).toHaveLength(24_900)
})

it('guards spot quotes only for known Curve LPs', async () => {
  const guard = vi.fn(async () => true)
  const registry = new SpotSourceRegistry(
    [
      {
        name: 'enso',
        priority: 10,
        supports: () => true,
        getSpotPrice: async () => ({ price: 1, timestamp, symbol: null, confidence: null })
      }
    ],
    guard
  )
  const coins = Array.from({ length: 50 }, (_, index) => `ethereum:0x${(index + 2).toString(16).padStart(40, '0')}`)
  const known = coins[7]
  const query = vi.fn(async () => ({ rows: [{ chain: 'ethereum', token: known.slice('ethereum:'.length) }] }))
  await handleSpot(request('spot', coins), env, registry, { query } as unknown as Pool)
  expect(query).toHaveBeenCalledTimes(1)
  expect(guard).toHaveBeenCalledTimes(1)
  expect(guard).toHaveBeenCalledWith(1, known.slice('ethereum:'.length), expect.any(Number), 1)
})

it('production registry forwards env and guards Enso without an injected guard', async () => {
  const client = fakeClient({
    [lpToken]: {
      N_COINS: 2n,
      coins: ['0x056fd409e1d7a124bd7017459dfea2f387b6d5cd', '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'],
      totalSupply: 0n
    }
  })
  const clientSpy = vi.spyOn(rpc, 'getChainClient').mockReturnValue(client)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ price: 5.7e20, decimals: 18 }), { status: 200 }))
  )
  try {
    const registry = spotSourceRegistry(env)
    await expect(registry.resolve(1, lpToken)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(clientSpy).toHaveBeenCalledWith(1, env)
  } finally {
    vi.unstubAllGlobals()
    clientSpy.mockRestore()
  }
})


it('rejects invalid write-down manifests', () => {
  const entry = { chain: 1, token, from: 1690736855, reason: 'Pool depleted' }
  expect(() => loadWriteDowns([entry, entry])).toThrow()
  for (const invalid of [{ token: 'bad' }, { from: 0 }, { reason: '' }]) {
    expect(() => loadWriteDowns([{ ...entry, ...invalid }])).toThrow()
  }
})
