import { encodeAbiParameters, type PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { curveAdapter } from '../../../src/sources/onchain/adapters/curve'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import {
  InvalidPricingError,
  ReadBudgetExceededError,
  RetryablePricingError
} from '../../../src/sources/onchain/errors'
import { resolveHistoricalGraph } from '../../../src/sources/onchain/graph'
import type { RecursivePriceAdapter } from '../../../src/sources/onchain/types'
import { adapterOptions, fakeClient, marketFor, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x3333333333333333333333333333333333333333'
const TOKEN_C = '0x6666666666666666666666666666666666666666'
const CURVE_PROVIDER = '0x0000000022d53366457f9d5e68ec105046fc4383'
const CURVE_POOL = '0x4444444444444444444444444444444444444444'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

/** Quotes dy proportionally to dx, so a whole-reserve quote matches the one-unit rate. */
const linearGetDy =
  (unitDy: bigint[][], decimals: number[]) =>
  (from: bigint, to: bigint, dx: bigint): bigint =>
    ((unitDy[Number(from)]?.[Number(to)] ?? 0n) * dx) / 10n ** BigInt(decimals[Number(from)])

const reads = {
  [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
  [CURVE_POOL]: { token: LP, N_COINS: 2n, coins: TOKEN_A, balances: 100n * 10n ** 6n },
  [TOKEN_A]: { decimals: 6 }
}

describe('curveAdapter', () => {
  it('preserves recursive quote fallback while keeping graph dependencies explicit', async () => {
    const quoteReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 100n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 10n ** 18n],
            [10n ** 6n, 0n]
          ],
          [6, 18]
        )
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const adapter = curveAdapter(adapterOptions(quoteReads))
    const recursive = await priceWith(adapter, { [TOKEN_A]: 1 }, LP)
    expect(recursive.path?.priceUsd).toBeCloseTo(2)
    expect(recursive.path?.metadata.valuationRule).toBe('get-dy-derived-constituents')
    const graph = await resolveHistoricalGraph({
      roots: [{ chainId: 1, token: LP, timestamp: null }],
      market: marketFor({ [TOKEN_A]: 1 }),
      prefetch: async () => {},
      adapters: () => [adapter]
    })
    const root = graph.nodes.find((node) => node.key === graph.roots[0])!
    expect(root.path).toBeNull()
    expect(root.routes[0].dependencies.map((dep) => dep.target.token.toLowerCase())).toEqual([TOKEN_A, TOKEN_B])
    const complete = await resolveHistoricalGraph({
      roots: [{ chainId: 1, token: LP, timestamp: null }],
      market: marketFor({ [TOKEN_A]: 1, [TOKEN_B]: 1 }),
      prefetch: async () => {},
      adapters: () => [adapter]
    })
    expect(complete.nodes.find((node) => node.key === complete.roots[0])?.path?.priceUsd).toBeCloseTo(2)
  })

  it('prices an LP token from the pool balances', async () => {
    const result = await priceWith(curveAdapter(adapterOptions(reads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(2)
    expect(result.path?.metadata.coinCountSource).toBe('pool-N_COINS')
  })

  it('discovers all constituents without prices and evaluates captured state without more RPC', async () => {
    const client = fakeClient(reads)
    let calls = 0
    const counting = {
      ...client,
      readContract: (args: never) => {
        calls += 1
        return client.readContract(args)
      }
    } as typeof client
    const adapter = curveAdapter({ clientForChain: () => counting })
    const plan = await adapter.discover({ chainId: 1, token: LP, timestamp: null })
    expect(plan?.dependencies).toHaveLength(2)
    expect(plan?.metadata.totalSupplyRaw).toBe((100n * 10n ** 18n).toString())
    const before = calls
    const inputs = plan!.dependencies.map(({ target }) => ({
      chainId: target.chainId,
      token: target.token,
      requestedTimestamp: target.timestamp,
      observedTimestamp: 100,
      priceUsd: 1,
      symbol: null,
      confidence: null,
      source: 'defillama' as const,
      adapter: 'defillama',
      inputs: [],
      metadata: {}
    }))
    expect(plan!.evaluate(inputs).priceUsd).toBeCloseTo(2)
    expect(plan!.evaluate(inputs).priceUsd).toBeCloseTo(2)
    expect(calls).toBe(before)
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
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
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
        getDyRaw: '500000000000000000',
        executableDxRaw: '100000000',
        executableDyRaw: '50000000000000000000'
      }
    ])
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
        get_dy: linearGetDy(
          [
            [0n, 0n, 0n],
            [0n, 0n, 0n],
            [0n, 2n * 10n ** 18n, 0n]
          ],
          [6, 18, 18]
        )
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
        getDyRaw: '2000000000000000000',
        executableDxRaw: '50000000000000000000',
        executableDyRaw: '100000000000000000000'
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
        balances: [1000n * 10n ** 18n, 10n * 10n ** 18n, 5n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 0n, 0n],
            [0n, 0n, 0n],
            [0n, 2n * 10n ** 18n, 0n]
          ],
          [18, 18, 18]
        )
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

    expect(result.path?.priceUsd).toBeCloseTo(20.01)
    expect(result.path?.metadata.derivedCoins).toEqual([
      {
        coinIndex: 2,
        address: TOKEN_C,
        anchorCoinIndex: 1,
        anchorAddress: TOKEN_B,
        dxRaw: '1000000000000000000',
        getDyRaw: '2000000000000000000',
        executableDxRaw: '5000000000000000000',
        executableDyRaw: '10000000000000000000'
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
        get_dy: linearGetDy(
          [
            [0n, 5n * 10n ** 17n, 0n],
            [0n, 0n, 0n],
            [0n, 3n * 10n ** 18n, 0n]
          ],
          [6, 18, 18]
        )
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
        get_dy: linearGetDy(
          [
            [0n, 1_000_000n * 10n ** 18n],
            [0n, 0n]
          ],
          [18, 18]
        )
      },
      [TOKEN_A]: { decimals: 18 },
      [TOKEN_B]: { decimals: 18 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(dustReads)), { [TOKEN_B]: 0.0001 }, LP)

    expect(result.path).toBeNull()
  })

  /**
   * A pegged pool: the one-unit rate stays flat as the anchor drains, so the
   * whole-reserve quote is the only read that sees the depletion.
   */
  const pegPool = (unpricedRaw: bigint, anchorRaw: bigint, rateNum: bigint, rateDen: bigint) => ({
    [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
    [CURVE_POOL]: {
      token: LP,
      N_COINS: 2n,
      coins: [TOKEN_A, TOKEN_B],
      balances: [unpricedRaw, anchorRaw],
      get_dy: (_from: bigint, _to: bigint, dx: bigint) => {
        const out = (dx * rateNum) / rateDen
        return out < anchorRaw ? out : anchorRaw
      }
    },
    [TOKEN_A]: { decimals: 18 },
    [TOKEN_B]: { decimals: 18 }
  })

  it('never grows more permissive as the anchor reserve drains', async () => {
    const unpriced = 1_000_000n * 10n ** 18n
    const anchors = [1_000_000n, 600_000n, 500_000n, 400_000n, 100_000n, 10_000n, 1_000n, 1n]
    const outcomes: Array<{ anchor: bigint; priceUsd: number | null }> = []
    for (const anchor of anchors) {
      const result = await priceWith(
        curveAdapter(adapterOptions(pegPool(unpriced, anchor * 10n ** 18n, 1n, 1n))),
        { [TOKEN_B]: 1 },
        LP
      )
      outcomes.push({ anchor, priceUsd: result.path?.priceUsd ?? null })
    }

    const firstReject = outcomes.findIndex((outcome) => outcome.priceUsd == null)
    expect(firstReject).toBeGreaterThan(0)
    expect(outcomes.slice(firstReject).every((outcome) => outcome.priceUsd == null)).toBe(true)
    for (const outcome of outcomes.slice(0, firstReject)) {
      const anchorValue = Number(outcome.anchor)
      expect(outcome.priceUsd as number).toBeLessThanOrEqual((3.5 * anchorValue) / 100)
    }
  })

  /** Two derived legs sharing one anchor; whole-reserve quotes cap at the anchor reserve. */
  const twoLegPool = (legRaw: bigint, anchorRaw: bigint) => ({
    [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
    [CURVE_POOL]: {
      token: LP,
      N_COINS: 3n,
      coins: [TOKEN_A, TOKEN_B, TOKEN_C],
      balances: [legRaw, anchorRaw, legRaw],
      get_dy: (_from: bigint, _to: bigint, dx: bigint) => (dx < anchorRaw ? dx : anchorRaw)
    },
    [TOKEN_A]: { decimals: 18 },
    [TOKEN_B]: { decimals: 18 },
    [TOKEN_C]: { decimals: 18 }
  })

  it('bounds the pool, not each leg, when derived legs share one anchor', async () => {
    const anchor = 100n * 10n ** 18n
    const balanced = await priceWith(curveAdapter(adapterOptions(twoLegPool(anchor, anchor))), { [TOKEN_B]: 1 }, LP)
    expect(balanced.path?.priceUsd).toBeCloseTo(3)
    expect(balanced.path?.priceUsd as number).toBeLessThanOrEqual(3.5)

    const skewed = await priceWith(
      curveAdapter(adapterOptions(twoLegPool(190n * 10n ** 18n, anchor))),
      { [TOKEN_B]: 1 },
      LP
    )
    expect(skewed.path).toBeNull()
  })

  /** Constant-product curve with a swap fee, the shape of a Curve crypto-v2 pool. */
  const constantProductPool = (feeBps: bigint) => {
    const reserves = [100n * 10n ** 18n, 100n * 10n ** 18n]
    return {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: reserves,
        get_dy: (from: bigint, to: bigint, dx: bigint) => {
          const x = reserves[Number(from)]
          const y = reserves[Number(to)]
          return (((y * dx) / (x + dx)) * (10_000n - feeBps)) / 10_000n
        }
      },
      [TOKEN_A]: { decimals: 18 },
      [TOKEN_B]: { decimals: 18 }
    }
  }

  it('prices a balanced constant-product pool across fee levels', async () => {
    for (const feeBps of [0n, 4n, 30n, 100n, 400n, 5_000n]) {
      const result = await priceWith(curveAdapter(adapterOptions(constantProductPool(feeBps))), { [TOKEN_B]: 1 }, LP)
      expect(result.path).not.toBeNull()
      expect(result.path?.metadata.valuationRule).toBe('get-dy-derived-constituents')
      expect(result.path?.priceUsd as number).toBeLessThanOrEqual(3.5)
      if (feeBps <= 400n) {
        expect(result.path?.priceUsd).toBeCloseTo(2, 1)
      }
    }
  })

  it('returns no price when the whole unpriced reserve cannot settle against the anchor', async () => {
    const result = await priceWith(
      curveAdapter(adapterOptions(pegPool(1_000_000n * 10n ** 18n, 5_000n * 10n ** 18n, 36n, 1000n))),
      { [TOKEN_B]: 1 },
      LP
    )

    expect(result.path).toBeNull()
  })

  it('returns no price when a small unpriced leg cannot settle at its marked rate', async () => {
    const one = 10n ** 18n
    const smallLeg = (wholeDy: bigint) => ({
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [10n * one, 100n * one],
        get_dy: (_from: bigint, _to: bigint, dx: bigint) => (dx <= one ? dx : wholeDy)
      },
      [TOKEN_A]: { decimals: 18 },
      [TOKEN_B]: { decimals: 18 }
    })

    const refused = await priceWith(curveAdapter(adapterOptions(smallLeg(one))), { [TOKEN_B]: 1 }, LP)
    expect(refused.path).toBeNull()

    const priced = await priceWith(curveAdapter(adapterOptions(smallLeg(10n * one))), { [TOKEN_B]: 1 }, LP)
    expect(priced.path?.priceUsd).toBeCloseTo(1.1)
    expect(priced.path?.metadata.valuationRule).toBe('get-dy-derived-constituents')
  })

  it('fails retryably instead of deriving when a constituent price read is transient', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
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

  it.each([
    ['an untyped market error', new Error('Network connection lost.'), 'retryable'],
    ['a market parse error', new SyntaxError('Unexpected end of JSON input'), 'retryable'],
    ['an invalid constituent', new InvalidPricingError('bad feed'), 'invalid']
  ])('fails as %s instead of deriving', async (_label, thrown, reason) => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const market = marketFor({ [TOKEN_B]: 2 })
    const engine = new RecursivePriceEngine(
      async (target) => {
        if (target.token.toLowerCase() === TOKEN_A) {
          throw thrown
        }
        return market(target)
      },
      [curveAdapter(adapterOptions(derivedReads))]
    )

    const result = await engine.resolve({ chainId: 1, token: LP, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe(reason)
  })

  it('fails retryably instead of deriving when a constituent read hits the budget', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const market = marketFor({ [TOKEN_B]: 2 })
    const engine = new RecursivePriceEngine(
      async (target) => {
        if (target.token.toLowerCase() === TOKEN_A) {
          throw new ReadBudgetExceededError('resolution budget spent')
        }
        return market(target)
      },
      [curveAdapter(adapterOptions(derivedReads))]
    )

    const result = await engine.resolve({ chainId: 1, token: LP, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('budget')
  })

  it('fails as cycle instead of deriving when a constituent loops through the LP', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const bounce: RecursivePriceAdapter = {
      name: 'bounce',
      async resolve(target, context) {
        if (target.token.toLowerCase() !== TOKEN_A) {
          return null
        }
        const input = await context.require({ ...target, token: LP }, 'lp')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      }
    }
    const engine = new RecursivePriceEngine(marketFor({ [TOKEN_B]: 2 }), [
      curveAdapter(adapterOptions(derivedReads)),
      bounce
    ])

    const result = await engine.resolve({ chainId: 1, token: LP, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('cycle')
  })

  it('does not pin a max-depth miss so a shallower branch can still price the LP', async () => {
    const ROOT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const DEEP = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const bothPriced = {
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
    const via = (name: string, self: string, child: string): RecursivePriceAdapter => ({
      name,
      async resolve(target, context) {
        if (target.token.toLowerCase() !== self) {
          return null
        }
        const input = await context.require({ ...target, token: child }, name)
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      }
    })
    const root: RecursivePriceAdapter = {
      name: 'root',
      async resolve(target, context) {
        if (target.token.toLowerCase() !== ROOT) {
          return null
        }
        await context.resolve({ ...target, token: DEEP })
        const input = await context.require({ ...target, token: LP }, 'shallow-lp')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      }
    }
    const engine = new RecursivePriceEngine(
      marketFor({ [TOKEN_A]: 1, [TOKEN_B]: 2 }),
      [root, via('deep', DEEP, LP), curveAdapter(adapterOptions(bothPriced))],
      3
    )

    const result = await engine.resolve({ chainId: 1, token: ROOT, timestamp: null })

    expect(result.failure).toBeNull()
    expect(result.path?.priceUsd).toBeCloseTo(5)
    expect(result.path?.inputs[0]?.adapter).toBe('curve-reserve-nav')
  })

  it('derives a missing leg when the pool only exposes int128 get_dy', async () => {
    const derivedReads = {
      [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 2n,
        coins: [TOKEN_A, TOKEN_B],
        balances: [100n * 10n ** 6n, 200n * 10n ** 18n],
        get_dy: linearGetDy(
          [
            [0n, 500_000_000_000_000_000n],
            [0n, 0n]
          ],
          [6, 18]
        )
      },
      [TOKEN_A]: { decimals: 6 },
      [TOKEN_B]: { decimals: 18 }
    }
    const client = fakeClient(derivedReads)
    const intOnly = {
      ...client,
      readContract: (args: {
        address: string
        functionName: string
        abi?: readonly { inputs?: readonly { type: string }[] }[]
      }) => {
        if (args.functionName === 'get_dy' && args.abi?.[0]?.inputs?.[0]?.type === 'uint256') {
          throw new Error('execution reverted')
        }
        return client.readContract(args as never)
      }
    } as unknown as typeof client

    const result = await priceWith(curveAdapter({ clientForChain: () => intOnly }), { [TOKEN_B]: 2 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(5)
    expect(result.path?.metadata.valuationRule).toBe('get-dy-derived-constituents')
    expect(result.path?.metadata.derivedCoins).toEqual([
      {
        coinIndex: 0,
        address: TOKEN_A,
        anchorCoinIndex: 1,
        anchorAddress: TOKEN_B,
        dxRaw: '1000000',
        getDyRaw: '500000000000000000',
        executableDxRaw: '100000000',
        executableDyRaw: '50000000000000000000'
      }
    ])
  })
})

describe('Curve complete-array discovery', () => {
  const zero = '0x0000000000000000000000000000000000000000'
  function adapter(data: string, failed = false) {
    const base = fakeClient(reads)
    const client = {
      ...base,
      readContract: (args: never) => {
        const { functionName } = args as { functionName: string }
        if (functionName === 'N_COINS') throw new Error('execution reverted')
        if (functionName === 'get_address') return Promise.resolve(CURVE_POOL)
        return base.readContract(args)
      },
      call: async () => {
        if (failed) throw new Error('fetch failed')
        return { data }
      }
    } as PublicClient
    return curveAdapter({ clientForChain: () => client })
  }
  it('reads the entire padded list instead of truncating to two coins', async () => {
    const data = encodeAbiParameters([{ type: 'address[4]' }], [[TOKEN_A, TOKEN_A, TOKEN_A, zero]])
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.path?.metadata.coinCount).toBe(3)
    expect(result.path?.metadata.coinCountSource).toBe('curve-registry-coins')
    expect(result.path?.priceUsd).toBeCloseTo(3)
  })
  it('rejects registry coins that disagree with the pool', async () => {
    const data = encodeAbiParameters([{ type: 'address[2]' }], [[TOKEN_A, LP]])
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.failure?.reason).toBe('invalid')
  })
  it.each([
    encodeAbiParameters([{ type: 'address[]' }], [[TOKEN_A, TOKEN_A]]),
    encodeAbiParameters([{ type: 'address[4]' }], [[TOKEN_A, zero, TOKEN_A, zero]]),
    encodeAbiParameters([{ type: 'address[2]' }], [[zero, zero]]),
    '0x1234'
  ])('rejects ambiguous or malformed lists: %s', async (data) => {
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })
  it('keeps failed whole-array reads retryable', async () => {
    const result = await priceWith(adapter('0x', true), { [TOKEN_A]: 1 }, LP)
    expect(result.failure?.reason).toBe('retryable')
  })
})
