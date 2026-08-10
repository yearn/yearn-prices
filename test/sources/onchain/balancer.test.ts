import { describe, expect, it } from 'vitest'
import { balancerAdapter } from '../../../src/sources/onchain/adapters/balancer'
import { adapterOptions, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x3333333333333333333333333333333333333333'
const VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8'
const POOL_ID = '0xaaaa'

const reads = {
  [LP]: { getPoolId: POOL_ID, decimals: 18, totalSupply: 100n * 10n ** 18n },
  [VAULT]: {
    getPoolTokens: [
      [TOKEN_A, TOKEN_B],
      [100n * 10n ** 6n, 50n * 10n ** 18n],
      0n,
    ],
  },
  [TOKEN_A]: { decimals: 6 },
  [TOKEN_B]: { decimals: 18 },
}

describe('balancerAdapter', () => {
  it('prices a BPT at vault NAV', async () => {
    const result = await priceWith(
      balancerAdapter(adapterOptions(reads)),
      { [TOKEN_A]: 1, [TOKEN_B]: 2 },
      LP,
    )

    expect(result.path?.priceUsd).toBeCloseTo(2)
  })

  it('excludes pre-minted BPT held by the pool itself', async () => {
    const composable = {
      ...reads,
      [LP]: { getPoolId: POOL_ID, decimals: 18, totalSupply: 200n * 10n ** 18n },
      [VAULT]: {
        getPoolTokens: [
          [LP, TOKEN_A],
          [100n * 10n ** 18n, 100n * 10n ** 6n],
          0n,
        ],
      },
    }

    const result = await priceWith(
      balancerAdapter(adapterOptions(composable)),
      { [TOKEN_A]: 1 },
      LP,
    )

    expect(result.path?.priceUsd).toBeCloseTo(1)
  })

  it('returns no price on chains without a vault', async () => {
    const result = await priceWith(balancerAdapter(adapterOptions(reads)), {}, LP, 146)

    expect(result.path).toBeNull()
  })

  it('fails when a constituent has no price', async () => {
    const result = await priceWith(balancerAdapter(adapterOptions(reads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path).toBeNull()
  })
})
