import { describe, expect, it } from 'vitest'
import { curveOracleAdapter } from '../../../src/sources/onchain/adapters/curve-oracle'
import { adapterOptions, priceWith } from './helpers'

const E18 = 10n ** 18n
const YCRV = '0xfcc5c47be19d06bf83eb04298b026f81069ff65b'
const YCRV_POOL = '0x99f5acc8ec2da2bc0771c32814eff52b712de1e5'
const CRV = '0xd533a949740bb3306d119cc777fa900ba034cd52'
const ETH_PLUS = '0xe72b141df173b999ae7c1adcbf60cc9833ce56a8'
const ETH_PLUS_POOL = '0x2c683fad51da2cd17793219cc86439c1875c353e'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const MIXED_TOKEN = '0x6440f144b7e50d6a8439336510312d2f54beb01d'
const MIXED_POOL = '0xefc6516323fbd28e80b85a497b65a86243a54b3e'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

function revert(): Error {
  const error = new Error('execution reverted')
  error.name = 'ContractFunctionExecutionError'
  return error
}

const unindexedOracle = (value: bigint) => (index?: bigint) => (index === undefined ? value : revert())

function yCrvReads(crvBalance: bigint) {
  return {
    [YCRV_POOL]: { coins: [CRV, YCRV], balances: [crvBalance, 0n], price_oracle: unindexedOracle(E18 / 2n) },
    [CRV]: { decimals: 18 },
    [YCRV]: { decimals: 18 }
  }
}

describe('curveOracleAdapter', () => {
  it('prices coin1 from a pool without stored rates', async () => {
    const options = adapterOptions(yCrvReads(100_000n * E18))

    const result = await priceWith(curveOracleAdapter(options), { [CRV]: 0.4 }, YCRV)

    expect(result.path?.priceUsd).toBeCloseTo(0.2)
  })

  it('prices coin0 and removes the stableswap-ng rate scaling', async () => {
    const options = adapterOptions({
      [ETH_PLUS_POOL]: {
        coins: [ETH_PLUS, WETH],
        balances: [0n, 100n * E18],
        stored_rates: [(11n * E18) / 10n, E18],
        price_oracle: (index?: bigint) => (index === 0n ? E18 : revert())
      },
      [ETH_PLUS]: { decimals: 18 },
      [WETH]: { decimals: 18 }
    })

    const result = await priceWith(curveOracleAdapter(options), { [WETH]: 2000 }, ETH_PLUS)

    expect(result.path?.priceUsd).toBeCloseTo(2200)
  })

  it('prices through a mixed-decimal pool and applies the floor in quote units', async () => {
    const reads = (usdcBalance: bigint) =>
      adapterOptions({
        [MIXED_POOL]: {
          coins: [MIXED_TOKEN, USDC],
          balances: [0n, usdcBalance],
          stored_rates: [E18, 10n ** 30n],
          price_oracle: (index?: bigint) => (index === 0n ? (102n * E18) / 100n : revert())
        },
        [MIXED_TOKEN]: { decimals: 18 },
        [USDC]: { decimals: 6 }
      })

    const priced = await priceWith(curveOracleAdapter(reads(30_000n * 10n ** 6n)), { [USDC]: 1 }, MIXED_TOKEN)
    const thin = await priceWith(curveOracleAdapter(reads(15_000n * 10n ** 6n)), { [USDC]: 1 }, MIXED_TOKEN)

    expect(priced.path?.priceUsd).toBeCloseTo(1 / 1.02)
    expect(thin.path).toBeNull()
    expect(thin.failure?.reason).toBe('invalid')
  })

  it('rejects a stableswap oracle at the EMA cap', async () => {
    const options = adapterOptions({
      [ETH_PLUS_POOL]: {
        coins: [ETH_PLUS, WETH],
        balances: [0n, 100n * E18],
        stored_rates: [E18, E18],
        price_oracle: (index?: bigint) => (index === 0n ? (195n * E18) / 100n : revert())
      },
      [ETH_PLUS]: { decimals: 18 },
      [WETH]: { decimals: 18 }
    })

    const result = await priceWith(curveOracleAdapter(options), { [WETH]: 2000 }, ETH_PLUS)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('prices a crypto pool oracle above the stableswap cap', async () => {
    const reads = yCrvReads(100_000n * E18)
    const options = adapterOptions({
      ...reads,
      [YCRV_POOL]: { ...reads[YCRV_POOL], price_oracle: unindexedOracle(3n * E18), price_scale: 3n * E18 }
    })

    const result = await priceWith(curveOracleAdapter(options), { [CRV]: 0.4 }, YCRV)

    expect(result.path?.priceUsd).toBeCloseTo(1.2)
  })

  it('rejects a pool with more than 2 coins', async () => {
    const reads = yCrvReads(100_000n * E18)
    const options = adapterOptions({ ...reads, [YCRV_POOL]: { ...reads[YCRV_POOL], coins: [CRV, YCRV, WETH] } })

    const result = await priceWith(curveOracleAdapter(options), { [CRV]: 0.4 }, YCRV)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('rejects a pool below the quote liquidity floor', async () => {
    const options = adapterOptions(yCrvReads(1_000n * E18))

    const result = await priceWith(curveOracleAdapter(options), { [CRV]: 0.4 }, YCRV)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('ignores tokens outside the allowlist', async () => {
    const options = adapterOptions(yCrvReads(100_000n * E18))

    const result = await priceWith(curveOracleAdapter(options), { [YCRV]: 0.4 }, CRV)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })
})
