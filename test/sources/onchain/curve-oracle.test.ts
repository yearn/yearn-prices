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
