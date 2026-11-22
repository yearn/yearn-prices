import { describe, expect, it } from 'vitest'
import { gammaAdapter } from '../../../src/sources/onchain/adapters/gamma'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import { adapterOptions, priceWith } from './helpers'

const HYPERVISOR = '0x3cc20a6795c4b57d9817399f68e83e71c8626580'
const POOL = '0x55caabb0d2b704fd0ef8192a7e35d8837e678207'
const USDC = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const WETH = '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'

// 1 USDC = 0.0005 WETH: raw token1/token0 = 0.0005 * 10^(18 - 6).
const sqrtPriceAt = (wethPerUsdc: number) => BigInt(Math.round(Math.sqrt(wethPerUsdc * 1e12) * 2 ** 96))

function reads(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    [HYPERVISOR]: {
      token0: USDC,
      token1: WETH,
      pool: POOL,
      getTotalAmounts: [1_000n * 10n ** 6n, 5n * 10n ** 17n],
      totalSupply: 10n * 10n ** 18n,
      decimals: 18,
      ...overrides[HYPERVISOR]
    },
    [POOL]: { token0: USDC, token1: WETH, globalState: [sqrtPriceAt(0.0005), 0], ...overrides[POOL] },
    [USDC]: { decimals: 6 },
    [WETH]: { decimals: 18 }
  }
}

const prices = { [USDC]: 1, [WETH]: 2000 }

describe('gammaAdapter', () => {
  it('prices a hypervisor share at its total amounts', async () => {
    const result = await priceWith(gammaAdapter(adapterOptions(reads())), prices, HYPERVISOR, 137)

    expect(result.path?.adapter).toBe('gamma-hypervisor-nav')
    expect(result.path?.priceUsd).toBeCloseTo(200)
    expect(result.path?.inputs).toHaveLength(2)
  })

  it('reads a Uniswap V3 slot0 when the pool is not Algebra', async () => {
    const uniswap = reads()
    uniswap[POOL] = { token0: USDC, token1: WETH, slot0: [sqrtPriceAt(0.0005), 0] }

    const result = await priceWith(gammaAdapter(adapterOptions(uniswap)), prices, HYPERVISOR, 137)

    expect(result.path?.priceUsd).toBeCloseTo(200)
  })

  it('refuses when the pool price disagrees with market prices', async () => {
    const skewed = reads({ [POOL]: { globalState: [sqrtPriceAt(0.00045), 0] } })

    const result = await priceWith(gammaAdapter(adapterOptions(skewed)), prices, HYPERVISOR, 137)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('refuses a hypervisor whose pool holds other tokens', async () => {
    const mismatched = reads({ [POOL]: { token1: '0x0000000000000000000000000000000000000001' } })

    const result = await priceWith(gammaAdapter(adapterOptions(mismatched)), prices, HYPERVISOR, 137)

    expect(result.failure?.reason).toBe('invalid')
  })

  it('refuses a hypervisor with zero supply', async () => {
    const empty = reads({ [HYPERVISOR]: { totalSupply: 0n } })

    const result = await priceWith(gammaAdapter(adapterOptions(empty)), prices, HYPERVISOR, 137)

    expect(result.failure?.reason).toBe('invalid')
  })

  it('needs every constituent price, never deriving a missing leg', async () => {
    const result = await priceWith(gammaAdapter(adapterOptions(reads())), { [USDC]: 1 }, HYPERVISOR, 137)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })

  it('keeps a transport failure retryable', async () => {
    const flaky = reads({ [HYPERVISOR]: { getTotalAmounts: new RetryablePricingError('rpc down') } })

    const result = await priceWith(gammaAdapter(adapterOptions(flaky)), prices, HYPERVISOR, 137)

    expect(result.failure?.reason).toBe('retryable')
  })

  it('ignores tokens that are not reviewed hypervisors', async () => {
    const result = await priceWith(gammaAdapter(adapterOptions(reads())), prices, HYPERVISOR, 1)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })
})
