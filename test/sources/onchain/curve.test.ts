import { describe, expect, it } from 'vitest'
import { curveAdapter } from '../../../src/sources/onchain/adapters/curve'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import { adapterOptions, fakeClient, marketFor, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x3333333333333333333333333333333333333333'
const TOKEN_C = '0x6666666666666666666666666666666666666666'
const CURVE_PROVIDER = '0x0000000022d53366457f9d5e68ec105046fc4383'
const CURVE_POOL = '0x4444444444444444444444444444444444444444'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const reads = {
  [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
  [CURVE_POOL]: { token: LP, N_COINS: 2n, coins: TOKEN_A, balances: 100n * 10n ** 6n },
  [TOKEN_A]: { decimals: 6 }
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
        balances: 10n * 10n ** 18n
      }
    }

    const result = await priceWith(curveAdapter(adapterOptions(nativeReads)), { [WETH]: 2000 }, LP)

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
        balances: 100n * 10n ** 6n
      },
      [TOKEN_A]: { decimals: 6 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(registryReads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(1)
  })

  it('reads each address-provider registry once across both registry walks', async () => {
    const registryReads = {
      [LP]: { decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_PROVIDER]: { get_address: CURVE_POOL },
      [CURVE_POOL]: {
        get_pool_from_lp_token: CURVE_POOL,
        get_n_coins: [1n, 1n],
        coins: TOKEN_A,
        balances: 100n * 10n ** 6n
      },
      [TOKEN_A]: { decimals: 6 }
    }
    const client = fakeClient(registryReads)
    let providerReads = 0
    const counting = {
      ...client,
      readContract: (args: { address: string; functionName: string }) => {
        if (args.functionName === 'get_address') {
          providerReads += 1
        }
        return client.readContract(args as never)
      }
    } as unknown as typeof client

    const result = await priceWith(curveAdapter({ clientForChain: () => counting }), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.metadata.coinCountSource).toBe('curve-registry')
    expect(providerReads).toBe(1)
  })

  it('refuses a token whose minter does not claim it as its LP', async () => {
    const counterfeit = '0x5555555555555555555555555555555555555555'
    const result = await priceWith(
      curveAdapter(
        adapterOptions({
          ...reads,
          [counterfeit]: { minter: CURVE_POOL, decimals: 18, totalSupply: 1n }
        })
      ),
      { [TOKEN_A]: 1 },
      counterfeit
    )

    expect(result.path).toBeNull()
  })

  it('refuses to price when a coin is missing from an authoritative count', async () => {
    const brokenReads = { ...reads, [CURVE_POOL]: { token: LP, N_COINS: 2n, balances: 1n } }

    const result = await priceWith(curveAdapter(adapterOptions(brokenReads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('returns no price when no coin count is authoritative', async () => {
    const result = await priceWith(curveAdapter(adapterOptions({ [LP]: { minter: CURVE_POOL, decimals: 18 } })), {}, LP)

    expect(result.path).toBeNull()
  })

  it('derives an unpriced leg from the largest priced reserve with get_dy', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: [
          [0n, 500_000_000_000_000_000n],
          [0n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(derivedReads)), { [TOKEN_B]: 2 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(5)
    expect(result.path?.metadata.valuationRule).toBe('get-dy-derived-constituents')
    expect(result.path?.metadata.derivedCoins).toEqual([
      {
        coinIndex: 0,
        address: TOKEN_A,
        anchorCoinIndex: 1,
        anchorAddress: TOKEN_B,
        dxRaw: '1000000',
        getDyRaw: '500000000000000000'
      }
    ])
  })

  it('does not derive a leg whose quote drains the anchor reserve', async () => {
    const thinReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 5n * 10n ** 17n],
        get_dy: [
          [0n, 500_000_000_000_000_000n],
          [0n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(thinReads)), { [TOKEN_B]: 2 }, LP)

    expect(result.path).toBeNull()
  })

  it('does not price a missing leg when get_dy reverts', async () => {
    const revertingReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: new Error('execution reverted')
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(revertingReads)), { [TOKEN_B]: 2 }, LP)

    expect(result.path).toBeNull()
  })

  it('does not price a pool when no coin has a market price', async () => {
    const unpricedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(unpricedReads)), {}, LP)

    expect(result.path).toBeNull()
  })

  it('does not price a missing leg when get_dy returns zero', async () => {
    const zeroReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: [
          [0n, 0n],
          [0n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(zeroReads)), { [TOKEN_B]: 2 }, LP)

    expect(result.path).toBeNull()
  })

  it('anchors a derived leg to the largest priced reserve, not the first', async () => {
    const anchorReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 3n,
        coins: [TOKEN_A, TOKEN_B, TOKEN_C],
        balances: [10n * 10n ** 6n, 300n * 10n ** 18n, 50n * 10n ** 18n],
        get_dy: [
          [0n, 0n, 0n],
          [0n, 0n, 0n],
          [0n, 2n * 10n ** 18n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 },
      [TOKEN_C]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(anchorReads)), { [TOKEN_A]: 1, [TOKEN_B]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(4.1)
    expect(result.path?.metadata.derivedCoins).toEqual([
      {
        coinIndex: 2,
        address: TOKEN_C,
        anchorCoinIndex: 1,
        anchorAddress: TOKEN_B,
        dxRaw: '1000000000000000000',
        getDyRaw: '2000000000000000000'
      }
    ])
  })

  it('anchors to the most valuable priced reserve, not the largest amount', async () => {
    const divergentReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 3n,
        coins: [TOKEN_A, TOKEN_B, TOKEN_C],
        balances: [1000n * 10n ** 18n, 10n * 10n ** 18n, 50n * 10n ** 18n],
        get_dy: [
          [0n, 0n, 0n],
          [0n, 0n, 0n],
          [0n, 2n * 10n ** 18n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 18 },
      [TOKEN_B]: { decimals: 18 },
      [TOKEN_C]: { decimals: 18 }
    }

    const result = await priceWith(
      curveAdapter(adapterOptions(divergentReads)),
      { [TOKEN_A]: 0.001, [TOKEN_B]: 100 },
      LP
    )

    expect(result.path?.priceUsd).toBeCloseTo(110.01)
    expect(result.path?.metadata.derivedCoins).toEqual([
      {
        coinIndex: 2,
        address: TOKEN_C,
        anchorCoinIndex: 1,
        anchorAddress: TOKEN_B,
        dxRaw: '1000000000000000000',
        getDyRaw: '2000000000000000000'
      }
    ])
  })

  it('derives every missing leg against one anchor', async () => {
    const multiReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 3n,
        coins: [TOKEN_A, TOKEN_B, TOKEN_C],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n, 50n * 10n ** 18n],
        get_dy: [
          [0n, 5n * 10n ** 17n, 0n],
          [0n, 0n, 0n],
          [0n, 3n * 10n ** 18n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 },
      [TOKEN_C]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(multiReads)), { [TOKEN_B]: 2 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(8)
    const derivedCoins = result.path?.metadata.derivedCoins as Array<{ coinIndex: number }>
    expect(derivedCoins.map((coin) => coin.coinIndex)).toEqual([0, 2])
  })

  it('returns no price when the anchor holds a negligible share of pool value', async () => {
    const dustReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [10n * 10n ** 18n, 990n * 10n ** 18n],
        get_dy: [
          [0n, 1_000_000n * 10n ** 18n],
          [0n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 18 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(dustReads)), { [TOKEN_B]: 0.0001 }, LP)

    expect(result.path).toBeNull()
  })

  it('fails retryably instead of deriving when a constituent price read is transient', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: [
          [0n, 500_000_000_000_000_000n],
          [0n, 0n]
        ]
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const market = marketFor({ [TOKEN_B]: 2 })
    const engine = new RecursivePriceEngine(
      async (target) => {
        if (target.token.toLowerCase() === TOKEN_A) {
          throw new RetryablePricingError('rpc unavailable')
        }
        return market(target)
      },
      [curveAdapter(adapterOptions(derivedReads))]
    )

    const result = await engine.resolve({ chainId: 1, token: LP, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('retryable')
  })
})
