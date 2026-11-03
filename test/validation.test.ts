import { describe, expect, it } from 'vitest'
import { parseBatchCoins, parseRangeCoins, parseTimestampSegment } from '../src/utils'

const RAW_TOKEN = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CHECKSUM_TOKEN = 'Ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

describe('historical request validation', () => {
  it('rejects batch aliases that normalize to one token key', () => {
    const coins = JSON.stringify({ [RAW_TOKEN]: [1695254399], [CHECKSUM_TOKEN]: [1695340799] })

    expect(() => parseBatchCoins(coins)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects range aliases that normalize to one token key', () => {
    const coins = JSON.stringify({
      [RAW_TOKEN]: [1695254399, 1695340799],
      [CHECKSUM_TOKEN]: [1695254399, 1695254399]
    })

    expect(() => parseRangeCoins(coins)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects timestamps outside safe integer or Date bounds as invalid input', () => {
    expect(() => parseTimestampSegment('100000000000000000000')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => parseTimestampSegment('8640000000000')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => parseBatchCoins(`{"${RAW_TOKEN}":[1e309]}`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => parseBatchCoins(`{"${RAW_TOKEN}":[-1, 1.5]}`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => parseRangeCoins(`{"${RAW_TOKEN}":[8639999999999, 8640000000000]}`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
  })

  it('accepts the largest timestamp that normalizes to a representable Date', () => {
    expect(parseTimestampSegment('8639999999999')).toBe(8639999999999)
  })
})
