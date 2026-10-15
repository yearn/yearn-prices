import { describe, expect, it } from 'vitest'
import { createCurveLpGuard } from '../../../src/sources/defillama/lp-guard'
import { fakeClient } from '../onchain/helpers'

const LP = '0xecdd0ce505da71cd9de855cd6804ba1e8c7bdb07'
const GUSD = '0x056fd409e1d7a124bd7017459dfea2f387b6d5cd'
const CRVUSD = '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'
const TIMESTAMP = 1_703_116_799

const stableReads = {
  [LP]: {
    N_COINS: 2n,
    coins: [GUSD, CRVUSD],
    get_virtual_price: 1_000_539_160_750_998_207n
  }
}

function guard(reads: Record<string, Record<string, unknown>>, prices: Record<string, number | null> = {}) {
  return createCurveLpGuard({
    clientForChain: () => fakeClient(reads),
    coinPrices: async (_chainId, coins) => coins.map((coin) => prices[coin.toLowerCase()] ?? null),
    blockForTimestamp: async () => 18_830_533n
  })
}

const peggedCoins = { [GUSD]: 1, [CRVUSD]: 0.998 }

describe('createCurveLpGuard', () => {
  it('rejects the GUSD-crvUSD quote from issue 62', async () => {
    const isPlausible = guard(stableReads, peggedCoins)
    expect(await isPlausible(1, LP, TIMESTAMP, 6_656_790_044_458_034)).toBe(false)
  })

  it('accepts a quote close to virtual price times the coin price', async () => {
    const isPlausible = guard(stableReads, peggedCoins)
    expect(await isPlausible(1, LP, TIMESTAMP, 0.9980676247130267)).toBe(true)
  })

  it('rejects a legacy four-coin pool quote of tens of millions per LP', async () => {
    const yBusd = '0x3b3ac5386837dc563660fb6a0937dfaa5924333b'
    const reads = {
      [yBusd]: { N_COINS: 4n, coins: [GUSD, CRVUSD, GUSD, CRVUSD], get_virtual_price: 1_200_000_000_000_000_000n }
    }
    expect(await guard(reads, peggedCoins)(1, yBusd, TIMESTAMP, 72_061_183.43742615)).toBe(false)
  })

  it('accepts a legitimate crypto-pool price far above virtual price times the cheapest coin', async () => {
    const tricrypto = '0xc4ad29ba4b3c580e6d59105fff484999997675ff'
    const reads = {
      [tricrypto]: {
        N_COINS: 3n,
        coins: [GUSD, CRVUSD, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'],
        get_virtual_price: 2_400_000_000_000_000_000n
      }
    }
    const prices = { ...peggedCoins, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 43_500 }
    expect(await guard(reads, prices)(1, tricrypto, TIMESTAMP, 3_000)).toBe(true)
  })

  it('passes a token that is not a Curve LP', async () => {
    expect(await guard({}, peggedCoins)(1, LP, TIMESTAMP, 1e18)).toBe(true)
  })

  it('passes when a coin has no price to bound the pool with', async () => {
    expect(await guard(stableReads, { [GUSD]: 1 })(1, LP, TIMESTAMP, 6_656_790_044_458_034)).toBe(true)
  })

  it('passes when the pool has no virtual price at that block', async () => {
    const { get_virtual_price: _omitted, ...withoutVirtualPrice } = stableReads[LP]
    expect(await guard({ [LP]: withoutVirtualPrice }, peggedCoins)(1, LP, TIMESTAMP, 1e18)).toBe(true)
  })

  it('fails open when coin price arity does not match the pool', async () => {
    const isPlausible = createCurveLpGuard({
      clientForChain: () => fakeClient(stableReads),
      coinPrices: async () => [],
      blockForTimestamp: async () => 18_830_533n
    })
    expect(await isPlausible(1, LP, TIMESTAMP, 6_656_790_044_458_034)).toBe(true)
  })

  it('passes when the chain has no RPC', async () => {
    const isPlausible = createCurveLpGuard({
      clientForChain: () => null,
      coinPrices: async (_chainId, coins) => coins.map(() => 1)
    })
    expect(await isPlausible(1, LP, TIMESTAMP, 1e18)).toBe(true)
  })

  it('passes when resolving the pool or block throws', async () => {
    const isPlausible = createCurveLpGuard({
      clientForChain: () => fakeClient(stableReads),
      coinPrices: async (_chainId, coins) =>
        coins.map((coin) => peggedCoins[coin.toLowerCase() as keyof typeof peggedCoins] ?? null),
      blockForTimestamp: async () => {
        throw new Error('rpc down')
      }
    })
    expect(await isPlausible(1, LP, TIMESTAMP, 6_656_790_044_458_034)).toBe(true)
  })
})
