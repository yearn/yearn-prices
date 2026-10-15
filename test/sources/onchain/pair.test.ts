import { describe, expect, it } from 'vitest'
import { pairAdapter } from '../../../src/sources/onchain/adapters/pair'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
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
})
