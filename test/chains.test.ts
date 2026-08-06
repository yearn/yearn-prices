import { describe, expect, test } from 'vitest'
import { chainIdToName, chainNameToId, parseTokenKey } from '../src/chains'

const TOKEN = '0x0000000000000000000000000000000000000001'

describe('chain registry', () => {
  test('routes HyperEVM chain 999 in both directions', () => {
    expect(chainIdToName(999)).toBe('hyperevm')
    expect(chainNameToId('HyperEVM')).toBe(999)
    expect(parseTokenKey(`hyperevm:${TOKEN}`)).toMatchObject({
      chain: 'hyperevm',
      tokenKey: `hyperevm:${TOKEN}`,
    })
  })

  test('continues to reject unregistered chains', () => {
    expect(chainIdToName(1234)).toBeUndefined()
    expect(chainNameToId('unknown')).toBeUndefined()
    expect(() => parseTokenKey(`unknown:${TOKEN}`)).toThrow('Unsupported chain: unknown')
  })
})
