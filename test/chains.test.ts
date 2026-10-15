import { describe, expect, it } from 'vitest'
import { chainIdToName, chainNameToId, parseTokenKey } from '../src/utils/chains'

const USDC = '0xb88339cb7199b77e23db6e890353e22632ba630f'

describe('hyperevm chain', () => {
  it('maps chain 999 to the DefiLlama slug and back', () => {
    expect(chainIdToName(999)).toBe('hyperliquid')
    expect(chainNameToId('hyperliquid')).toBe(999)
  })

  it('parses a hyperliquid token key', () => {
    expect(parseTokenKey(`HyperLiquid:${USDC}`)).toMatchObject({
      chain: 'hyperliquid',
      token: '0xb88339CB7199b77E23DB6E890353E22632Ba630f'
    })
  })
})

describe('parseTokenKey', () => {
  it.each([
    [`hyperevm:${USDC}`, 'Unsupported chain: hyperevm'],
    ['nocolon', 'Invalid token key: nocolon'],
    ['ethereum:0xnothex', 'Unsupported token address: 0xnothex']
  ])('throws a 400 ApiError for %s', (key, message) => {
    expect(() => parseTokenKey(key)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', status: 400, message }))
  })
})
