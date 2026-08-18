import { describe, expect, it } from 'vitest'
import { WRAPPED_NATIVE } from '../../../src/sources/onchain/tokens'
import { CHAIN_ID_TO_NAME } from '../../../src/utils/chains'

describe('WRAPPED_NATIVE', () => {
  it('covers every chain the service supports', () => {
    const missing = Object.keys(CHAIN_ID_TO_NAME)
      .map(Number)
      .filter((chainId) => !WRAPPED_NATIVE[chainId])

    expect(missing).toEqual([])
  })

  it('holds lowercase addresses, which is how adapters compare them', () => {
    for (const [chainId, address] of Object.entries(WRAPPED_NATIVE)) {
      expect(address, `chain ${chainId}`).toBe(address.toLowerCase())
      expect(address, `chain ${chainId}`).toMatch(/^0x[0-9a-f]{40}$/)
    }
  })
})
