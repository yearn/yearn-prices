import { describe, expect, it } from 'vitest'
import { curveAdapter } from '../../../src/sources/onchain/adapters/curve'
import { adapterOptions, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const CURVE_PROVIDER = '0x0000000022d53366457f9d5e68ec105046fc4383'
const CURVE_POOL = '0x4444444444444444444444444444444444444444'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const reads = {
  [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
  [CURVE_POOL]: { token: LP, N_COINS: 2n, coins: TOKEN_A, balances: 100n * 10n ** 6n },
  [TOKEN_A]: { decimals: 6 },
}

describe('curveAdapter', () => {
  it('prices an LP token from the pool balances', async () => {
    const result = await priceWith(curveAdapter(adapterOptions(reads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(2)
    expect(result.path?.metadata.coinCountSource).toBe('pool-N_COINS')
  })

  it('prices native pool legs as wrapped native', async () => {
    const nativeReads = {
      ...reads,
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 1n,
        coins: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        balances: 10n * 10n ** 18n,
      },
    }

    const result = await priceWith(
      curveAdapter(adapterOptions(nativeReads)),
      { [WETH]: 2000 },
      LP,
    )

    expect(result.path?.priceUsd).toBeCloseTo(200)
  })

  it('falls back to the address provider registry for the pool', async () => {
    const registryReads = {
      [LP]: { decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_PROVIDER]: { get_address: CURVE_POOL },
      [CURVE_POOL]: {
        get_pool_from_lp_token: CURVE_POOL,
        N_COINS: 1n,
        coins: TOKEN_A,
        balances: 100n * 10n ** 6n,
      },
      [TOKEN_A]: { decimals: 6 },
    }

    const result = await priceWith(
      curveAdapter(adapterOptions(registryReads)),
      { [TOKEN_A]: 1 },
      LP,
    )

    expect(result.path?.priceUsd).toBeCloseTo(1)
  })

  it('refuses a token whose minter does not claim it as its LP', async () => {
    const counterfeit = '0x5555555555555555555555555555555555555555'
    const result = await priceWith(
      curveAdapter(
        adapterOptions({
          ...reads,
          [counterfeit]: { minter: CURVE_POOL, decimals: 18, totalSupply: 1n },
        }),
      ),
      { [TOKEN_A]: 1 },
      counterfeit,
    )

    expect(result.path).toBeNull()
  })

  it('refuses to price when a coin is missing from an authoritative count', async () => {
    const brokenReads = { ...reads, [CURVE_POOL]: { token: LP, N_COINS: 2n, balances: 1n } }

    const result = await priceWith(
      curveAdapter(adapterOptions(brokenReads)),
      { [TOKEN_A]: 1 },
      LP,
    )

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('returns no price when no coin count is authoritative', async () => {
    const result = await priceWith(
      curveAdapter(adapterOptions({ [LP]: { minter: CURVE_POOL, decimals: 18 } })),
      {},
      LP,
    )

    expect(result.path).toBeNull()
  })
})
