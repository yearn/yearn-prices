import { describe, expect, it } from 'vitest'
import { reserveRTokenAdapter } from '../../../src/sources/onchain/adapters/reserve-rtoken'
import { adapterOptions, priceWith } from './helpers'

const RTOKEN = '0x78da5799cf427fee11e9996982f4150ece7a99a7'
const OTHER = '0x1111111111111111111111111111111111111111'
const MAIN = '0x4444444444444444444444444444444444444444'
const BASKET_HANDLER = '0x5555555555555555555555555555555555555555'
const USDC = '0x6666666666666666666666666666666666666666'
const DAI = '0x7777777777777777777777777777777777777777'

function reserveReads(overrides: Record<string, unknown> = {}) {
  return {
    [RTOKEN]: {
      main: MAIN,
      decimals: 18,
      totalSupply: 100n * 10n ** 18n,
      basketsNeeded: 100n * 10n ** 18n,
      redemptionAvailable: 1000n * 10n ** 18n,
      ...overrides,
    },
    [MAIN]: { basketHandler: BASKET_HANDLER, frozen: false },
    [BASKET_HANDLER]: {
      fullyCollateralized: true,
      quote: [
        [USDC, DAI],
        [500_000n, 5n * 10n ** 17n],
      ],
    },
    [USDC]: { decimals: 6 },
    [DAI]: { decimals: 18 },
  }
}

describe('reserveRTokenAdapter', () => {
  it('prices an RToken from its redemption basket', async () => {
    const options = adapterOptions(reserveReads())

    const result = await priceWith(reserveRTokenAdapter(options), { [USDC]: 1, [DAI]: 1 }, RTOKEN)

    expect(result.path?.priceUsd).toBeCloseTo(1)
  })

  it('refuses a frozen RToken', async () => {
    const reads = reserveReads()
    reads[MAIN] = { basketHandler: BASKET_HANDLER, frozen: true }

    const result = await priceWith(
      reserveRTokenAdapter(adapterOptions(reads)),
      { [USDC]: 1, [DAI]: 1 },
      RTOKEN,
    )

    expect(result.path).toBeNull()
  })

  it('refuses an under-collateralized RToken', async () => {
    const reads = reserveReads()
    reads[BASKET_HANDLER] = { ...reads[BASKET_HANDLER], fullyCollateralized: false }

    const result = await priceWith(
      reserveRTokenAdapter(adapterOptions(reads)),
      { [USDC]: 1, [DAI]: 1 },
      RTOKEN,
    )

    expect(result.path).toBeNull()
  })

  it('refuses an RToken whose redemption throttle is exhausted', async () => {
    const options = adapterOptions(reserveReads({ redemptionAvailable: 1n }))

    const result = await priceWith(reserveRTokenAdapter(options), { [USDC]: 1, [DAI]: 1 }, RTOKEN)

    expect(result.path).toBeNull()
  })

  it('fails when a basket constituent has no price', async () => {
    const options = adapterOptions(reserveReads())

    const result = await priceWith(reserveRTokenAdapter(options), { [USDC]: 1 }, RTOKEN)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })

  it('ignores tokens outside the allowlist', async () => {
    const options = adapterOptions(reserveReads())

    const result = await priceWith(reserveRTokenAdapter(options), {}, OTHER)

    expect(result.path).toBeNull()
  })
})
