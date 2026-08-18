import { describe, expect, it } from 'vitest'
import { yip88LiquidLockerAdapter } from '../../../src/sources/onchain/adapters/yip88-liquid-locker'
import { adapterOptions, priceWith } from './helpers'

const LOCKER = '0x95710bde45c8d384a976cc58cc7a7e489576b098'
const OTHER = '0x1111111111111111111111111111111111111111'
const FACILITY = '0xba18d0df75a3ff58ef40a8fc0d3e4db74a0e681d'
const YFI = '0x6666666666666666666666666666666666666666'
const WRAPPER = '0x7777777777777777777777777777777777777777'
const WAD = 10n ** 18n

function reads(overrides: Record<string, unknown> = {}) {
  return {
    [LOCKER]: { decimals: 18 },
    [FACILITY]: {
      yfi: YFI,
      fee: WAD / 100n,
      tokens: LOCKER,
      scales: 10n,
      capacities: 1000n * WAD,
      enabled: true,
      used: 0n,
      ...overrides
    },
    [YFI]: { decimals: 18, balanceOf: 1000n * WAD }
  }
}

describe('yip88LiquidLockerAdapter', () => {
  it('prices a locker at its net redemption value', async () => {
    const result = await priceWith(yip88LiquidLockerAdapter(adapterOptions(reads())), { [YFI]: 1000 }, LOCKER)

    expect(result.path?.priceUsd).toBeCloseTo(99)
  })

  it('prices through the facility wrapper when it accepts one', async () => {
    const wrapperReads = {
      ...reads({ tokens: WRAPPER }),
      [WRAPPER]: { asset: LOCKER, maxDeposit: 100n * WAD, convertToShares: WAD / 2n }
    }

    const result = await priceWith(yip88LiquidLockerAdapter(adapterOptions(wrapperReads)), { [YFI]: 1000 }, LOCKER)

    expect(result.path?.priceUsd).toBeCloseTo(49.5)
  })

  it('returns no price when the index is disabled', async () => {
    const result = await priceWith(
      yip88LiquidLockerAdapter(adapterOptions(reads({ enabled: false }))),
      { [YFI]: 1000 },
      LOCKER
    )

    expect(result.path).toBeNull()
  })

  it('returns no price when capacity is exhausted', async () => {
    const result = await priceWith(
      yip88LiquidLockerAdapter(adapterOptions(reads({ capacities: 1n, used: 1n }))),
      { [YFI]: 1000 },
      LOCKER
    )

    expect(result.path).toBeNull()
  })

  it('returns no price when the facility cannot cover the redemption', async () => {
    const poorFacility = reads()
    poorFacility[YFI] = { decimals: 18, balanceOf: 1n }

    const result = await priceWith(yip88LiquidLockerAdapter(adapterOptions(poorFacility)), { [YFI]: 1000 }, LOCKER)

    expect(result.path).toBeNull()
  })

  it('ignores tokens outside the locker allowlist', async () => {
    const result = await priceWith(yip88LiquidLockerAdapter(adapterOptions(reads())), { [YFI]: 1000 }, OTHER)

    expect(result.path).toBeNull()
  })
})
