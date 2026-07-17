import { describe, expect, it } from 'vitest'
import {
  BAD_DEFILLAMA_TOKEN_KEYS,
  isBadDefiLlamaToken,
  isBadDefiLlamaTokenKey,
} from '../src/bad-defillama-tokens'
import { capConfidence } from '../src/format'

describe('capConfidence', () => {
  it('clamps to [0, 1]', () => {
    expect(capConfidence(1.01)).toBe(1)
    expect(capConfidence(-0.5)).toBe(0)
    expect(capConfidence(0.7)).toBe(0.7)
  })

  it('passes through null/undefined as null', () => {
    expect(capConfidence(null)).toBeNull()
    expect(capConfidence(undefined)).toBeNull()
  })
})

describe('bad DefiLlama Curve LP denylist', () => {
  it('flags the four legacy Curve LPs with garbage DefiLlama rows', () => {
    // Y pool
    expect(isBadDefiLlamaToken('ethereum', '0xdF5e0e81Dff6FAF3A7e52BA697820c5e32D806A8')).toBe(true)
    // yBUSD pool
    expect(isBadDefiLlamaToken('ethereum', '0x3B3Ac5386837Dc563660FB6a0937DFAa5924333B')).toBe(true)
    // PAX pool
    expect(isBadDefiLlamaToken('ethereum', '0xD905e2eaeBe188fc92179b6350807D8bd91Db0D8')).toBe(true)
    // sUSD plain3
    expect(isBadDefiLlamaToken('ethereum', '0xC25a3A3b969415c80451098fa907EC722572917F')).toBe(true)
    expect(isBadDefiLlamaTokenKey('ethereum:0xdF5e0e81Dff6FAF3A7e52BA697820c5e32D806A8')).toBe(true)
  })

  it('does not flag non-Curve garbage (Aerodrome / Pendle) or normal tokens', () => {
    // Aerodrome — out of scope for this PR
    expect(isBadDefiLlamaToken('base', '0x2223F9FE624F69Da4D8256A7bCc9104FBA7F8f75')).toBe(false)
    // Pendle
    expect(isBadDefiLlamaToken('arbitrum', '0x0A21291A184cf36aD3B0a0def4A17C12Cbd66A14')).toBe(false)
    // USDC
    expect(isBadDefiLlamaToken('ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(false)
  })

  it('is case-insensitive on address', () => {
    expect(isBadDefiLlamaToken('ethereum', '0xdf5e0e81dff6faf3a7e52ba697820c5e32d806a8')).toBe(true)
  })

  it('is exactly the four Curve LPs found in production', () => {
    expect(BAD_DEFILLAMA_TOKEN_KEYS.size).toBe(4)
  })
})
