import { describe, expect, it } from 'vitest'
import { readChartCoin } from '../../src/backfill/chart-envelope'

describe('readChartCoin', () => {
  it('returns the coin when the envelope holds the identifier', () => {
    const coin = { symbol: 'USDC', prices: [] }
    expect(readChartCoin({ coins: { 'ethereum:0xa': coin } }, 'ethereum:0xa')).toEqual({ kind: 'coin', coin })
  })

  it('reports a legitimate miss when the envelope omits the identifier', () => {
    expect(readChartCoin({ coins: {} }, 'ethereum:0xa')).toEqual({ kind: 'missing' })
  })

  it('reports malformed envelopes without coins', () => {
    expect(readChartCoin({}, 'ethereum:0xa')).toEqual({ kind: 'invalid' })
    expect(readChartCoin(null, 'ethereum:0xa')).toEqual({ kind: 'invalid' })
    expect(readChartCoin([], 'ethereum:0xa')).toEqual({ kind: 'invalid' })
  })

  it('reports malformed envelopes whose coins is not a record', () => {
    expect(readChartCoin({ coins: [] }, 'ethereum:0xa')).toEqual({ kind: 'invalid' })
    expect(readChartCoin({ coins: 'nope' }, 'ethereum:0xa')).toEqual({ kind: 'invalid' })
    expect(readChartCoin({ coins: null }, 'ethereum:0xa')).toEqual({ kind: 'invalid' })
  })
})
