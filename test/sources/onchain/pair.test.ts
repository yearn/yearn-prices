import { describe, expect, it } from 'vitest'
import { pairAdapter } from '../../../src/sources/onchain/adapters/pair'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import { resolveHistoricalGraph } from '../../../src/sources/onchain/graph'
import { adapterOptions, BLOCK_TIMESTAMP, fakeClient, marketFor, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x3333333333333333333333333333333333333333'

const reads = {
  [LP]: {
    token0: TOKEN_A,
    token1: TOKEN_B,
    getReserves: [100n * 10n ** 6n, 50n * 10n ** 18n, 0n],
    totalSupply: 100n * 10n ** 18n,
    decimals: 18
  },
  [TOKEN_A]: { decimals: 6 },
  [TOKEN_B]: { decimals: 18 }
}

describe('pairAdapter', () => {
  it('prices an LP token at reserve NAV', async () => {
    const result = await priceWith(pairAdapter(adapterOptions(reads)), { [TOKEN_A]: 1, [TOKEN_B]: 2 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(2)
    expect(result.path?.inputs).toHaveLength(2)
  })

  it('refuses to price when one leg has no price', async () => {
    const result = await priceWith(pairAdapter(adapterOptions(reads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })

  it('reports a transient leg failure as retryable', async () => {
    const flaky = { ...reads, [TOKEN_B]: { decimals: new RetryablePricingError('rpc down') } }

    const result = await priceWith(pairAdapter(adapterOptions(flaky)), { [TOKEN_A]: 1, [TOKEN_B]: 2 }, LP)

    expect(result.failure?.reason).toBe('retryable')
  })

  it('returns no price for a token that is not a pair', async () => {
    const result = await priceWith(pairAdapter(adapterOptions({ [LP]: { decimals: 18 } })), {}, LP)

    expect(result.path).toBeNull()
  })

  describe('Velodrome V2 alETH-WETH at a dated block', () => {
    const POOL = '0xa1055762336f92b4b8d2edc032a0ce45ead6280a'
    const ALETH = '0x3e29d3a9316dab217754d13b28646b76607c5f04'
    const WETH = '0x4200000000000000000000000000000000000006'
    const velodrome = {
      [POOL]: {
        token0: ALETH,
        token1: WETH,
        getReserves: [843417463083462358494n, 523666953696484282477n, 0n],
        totalSupply: 683006446249607751833n,
        decimals: 18
      },
      [ALETH]: { decimals: 18 },
      [WETH]: { decimals: 18 }
    }
    const PINNED = 158_211_811
    const readBlocks: unknown[] = []
    const client = fakeClient(velodrome)
    const recording = {
      ...client,
      readContract: (args: { blockNumber?: bigint }) => {
        readBlocks.push(args.blockNumber)
        return client.readContract(args as never)
      }
    } as typeof client
    const dated = (prices: Record<string, number>) =>
      new RecursivePriceEngine(marketFor(prices), [pairAdapter({ clientForChain: () => recording })]).resolve({
        chainId: 10,
        token: POOL,
        timestamp: BLOCK_TIMESTAMP + 60,
        blockNumber: PINNED
      })

    it('prices the LP from reserves read at the dated block', async () => {
      const result = await dated({ [ALETH]: 2362.7903748397657, [WETH]: 2413.6269911487775 })

      expect(result.path?.priceUsd).toBeCloseTo(4768.264451152301, 6)
      expect(result.path?.blockNumber).toBe(PINNED)
      expect(result.path?.metadata.block).toMatchObject({ number: PINNED, distanceSeconds: 60 })
      expect(readBlocks.length).toBeGreaterThanOrEqual(7)
      expect(new Set(readBlocks)).toEqual(new Set([BigInt(PINNED)]))
    })

    it('leaves the LP unresolved when a constituent has no price', async () => {
      const result = await dated({ [WETH]: 2413.6269911487775 })

      expect(result.path).toBeNull()
      expect(result.failure?.reason).toBe('unsupported')
    })
  })

  describe('one-leg derivation', () => {
    const withStable = (stable?: boolean) => ({
      ...reads,
      [LP]: { ...reads[LP], ...(stable === undefined ? {} : { stable }) }
    })

    it('derives the missing leg of a volatile pair in the recursive engine and the graph', async () => {
      const adapter = pairAdapter(adapterOptions(withStable(false)))
      const recursive = await priceWith(adapter, { [TOKEN_A]: 1 }, LP)
      expect(recursive.path?.priceUsd).toBeCloseTo(2)
      expect(recursive.path?.inputs).toHaveLength(1)
      expect(recursive.path?.metadata).toMatchObject({
        valuationRule: 'constant-product-derived-constituent',
        derivedReserves: [{ index: 1, address: TOKEN_B, anchorIndex: 0, impliedPriceUsd: 2 }]
      })
      const graph = await resolveHistoricalGraph({
        roots: [{ chainId: 1, token: LP, timestamp: null }],
        market: marketFor({ [TOKEN_A]: 1 }),
        prefetch: async () => {},
        adapters: () => [adapter]
      })
      const root = graph.nodes.find((node) => node.key === graph.roots[0])
      expect(root?.path?.priceUsd).toBeCloseTo(2)
      expect(root?.path?.metadata.valuationRule).toBe('constant-product-derived-constituent')
    })

    it.each([
      ['a stable pair', true],
      ['a pair without stable()', undefined]
    ])('does not derive a missing leg for %s', async (_, stable) => {
      const result = await priceWith(pairAdapter(adapterOptions(withStable(stable))), { [TOKEN_A]: 1 }, LP)
      expect(result.path).toBeNull()
      expect(result.failure?.reason).toBe('unsupported')
    })
  })
})

describe('canonical stable-pool missing-leg quotes', () => {
  const factory = '0xf1046053aa5682b4f9a81b5481394da16be5ff5a'
  const e18 = 10n ** 18n
  const reserveA = 25_000n * 10n ** 6n
  const reserveB = 50_000n * e18
  const stableReads = () => ({
    [LP]: {
      ...reads[LP],
      stable: true,
      factory,
      getReserves: [reserveA, reserveB, 0n],
      getAmountOut: (amount: bigint) => (amount === reserveB ? 15_000n * 10n ** 6n : amount / (2n * 10n ** 12n))
    },
    [factory]: { getPool: LP, isPaused: false },
    [TOKEN_A]: { decimals: 6, balanceOf: reserveA },
    [TOKEN_B]: { decimals: 18, balanceOf: reserveB }
  })

  it('uses mixed-decimal swap outputs, not a stable peg, in both engines', async () => {
    const adapter = pairAdapter(adapterOptions(stableReads()))
    const result = await priceWith(adapter, { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path?.priceUsd).toBeCloseTo(500)
    expect(result.path?.metadata.derivedReserves).toMatchObject([{ impliedPriceUsd: 0.5 }])
    expect(result.path?.metadata.valuationRule).toBe('stable-swap-derived-constituent')
    expect(result.path?.inputs).toHaveLength(1)
    const graph = await resolveHistoricalGraph({
      roots: [{ chainId: 10, token: LP, timestamp: null }],
      market: marketFor({ [TOKEN_A]: 1 }),
      prefetch: async () => {},
      adapters: () => [adapter]
    })
    expect(graph.nodes.find((node) => node.key === graph.roots[0])?.path?.priceUsd).toBeCloseTo(500)
  })

  it('accepts the 7/24 executable share of a skewed x³y + xy³ pool', async () => {
    const data = stableReads()
    data[LP].getAmountOut = (amount) => (amount === reserveB ? (reserveA * 7n) / 8n : (amount * 3n) / (2n * 10n ** 12n))
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path?.priceUsd).toBeCloseTo(1000)
  })

  it('requires registration at the canonical factory', async () => {
    const data = stableReads()
    data[factory].getPool = TOKEN_A
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('rejects paused swaps even if the quote function returns a value', async () => {
    const data = stableReads()
    data[factory].isPaused = true
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('pins factory, backing and swap reads to the requested historical block', async () => {
    const client = fakeClient(stableReads())
    const calls: { blockNumber?: bigint; functionName: string }[] = []
    const recording = {
      ...client,
      readContract: (args: { blockNumber?: bigint; functionName: string }) => {
        calls.push(args)
        return client.readContract(args as never)
      }
    } as typeof client
    const result = await new RecursivePriceEngine(marketFor({ [TOKEN_A]: 1 }), [
      pairAdapter({ clientForChain: () => recording })
    ]).resolve({ chainId: 10, token: LP, timestamp: BLOCK_TIMESTAMP + 30, blockNumber: 19_000_000 })
    expect(result.path?.priceUsd).toBeCloseTo(500)
    expect(calls.filter((call) => call.functionName === 'getAmountOut')).toHaveLength(2)
    expect(new Set(calls.map((call) => call.blockNumber))).toEqual(new Set([19_000_000n]))
  })

  it('rejects a thin independently priced reserve', async () => {
    const result = await priceWith(pairAdapter(adapterOptions(stableReads())), { [TOKEN_A]: 0.1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('rejects accounting reserves without actual backing', async () => {
    const data = stableReads()
    data[TOKEN_B].balanceOf = 0n
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('rejects a tiny quote with insufficient full-reserve payout', async () => {
    const data = stableReads()
    data[LP].getAmountOut = (amount) => (amount === reserveB ? 1n : amount / (2n * 10n ** 12n))
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('preserves retryable failures instead of inferring a price', async () => {
    const data = stableReads()
    data[LP].getAmountOut = () => {
      throw new RetryablePricingError('archive unavailable')
    }
    const result = await priceWith(pairAdapter(adapterOptions(data)), { [TOKEN_A]: 1 }, LP, 10)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('retryable')
  })
})
