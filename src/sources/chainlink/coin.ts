import type { HistoricalPriceResult } from '../types'

export function toHistoricalPrice(
  answer: unknown,
  decimals: unknown,
  updatedAt: unknown,
  blockTimestamp: unknown,
  symbol: string | null,
  isUsable: (price: unknown, timestamp: unknown) => boolean
): HistoricalPriceResult | null {
  if (
    typeof answer !== 'bigint' ||
    answer <= 0n ||
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    typeof updatedAt !== 'bigint' ||
    typeof blockTimestamp !== 'bigint'
  ) {
    return null
  }

  const timestamp = Number(updatedAt)
  const observedTimestamp = Number(blockTimestamp)
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !Number.isSafeInteger(observedTimestamp) ||
    observedTimestamp <= 0 ||
    timestamp + 86_400 < observedTimestamp
  ) {
    return null
  }

  const price = Number(answer) / 10 ** decimals
  if (!isUsable(price, timestamp)) {
    return null
  }

  return { price, timestamp, symbol, confidence: null }
}
