import { describe, expect, it } from 'vitest'
import { pairAdapter } from '../../../src/sources/onchain/adapters/pair'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import { adapterOptions, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const TOKEN_B = '0x3333333333333333333333333333333333333333'

const reads = {
  [LP]: {
    token0: TOKEN_A,
    token1: TOKEN_B,
    getReserves: [100n * 10n ** 6n, 50n * 10n ** 18n, 0n],
    totalSupply: 100n * 10n ** 18n,
    decimals: 18,
  },
  [TOKEN_A]: { decimals: 6 },
  [TOKEN_B]: { decimals: 18 },
}

describe('pairAdapter', () => {
  it('prices an LP token at reserve NAV', async () => {
    const result = await priceWith(
      pairAdapter(adapterOptions(reads)),
      { [TOKEN_A]: 1, [TOKEN_B]: 2 },
      LP,
    )

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

    const result = await priceWith(
      pairAdapter(adapterOptions(flaky)),
      { [TOKEN_A]: 1, [TOKEN_B]: 2 },
      LP,
    )

    expect(result.failure?.reason).toBe('retryable')
  })

  it('returns no price for a token that is not a pair', async () => {
    const result = await priceWith(pairAdapter(adapterOptions({ [LP]: { decimals: 18 } })), {}, LP)

    expect(result.path).toBeNull()
  })
})
