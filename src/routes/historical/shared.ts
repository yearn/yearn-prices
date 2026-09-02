import { ApiError } from '../../http'
import type { BatchHistoricalResponseCoin, ExactPriceRecord, HistoricalRequestTuple } from '../../types'
import { parseTokenKey } from '../../utils'

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_FOUND'
}

export function buildTokenKey(chain: string, token: string): string {
  return `${chain}:${token}`
}

export function toExactKey(entry: HistoricalRequestTuple | ExactPriceRecord): string {
  return `${entry.chain}:${entry.token}:${entry.timestamp}`
}

export function buildOriginalKeyMap(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const originalKey of Object.keys(JSON.parse(raw) as Record<string, unknown>)) {
    const { chain, token } = parseTokenKey(originalKey)
    const normalizedKey = buildTokenKey(chain, token)
    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, originalKey)
    }
  }
  return map
}

export function groupRowsByToken(
  rows: ExactPriceRecord[],
  originalKeyMap: Map<string, string>
): Map<string, BatchHistoricalResponseCoin> {
  const coins = new Map<string, BatchHistoricalResponseCoin>()
  for (const row of rows) {
    const normalizedKey = buildTokenKey(row.chain, row.token)
    const tokenKey = originalKeyMap.get(normalizedKey) ?? normalizedKey
    const current = coins.get(tokenKey) ?? { symbol: row.symbol, prices: [] }
    current.prices.push({
      timestamp: row.timestamp,
      price: row.price,
      confidence: row.confidence,
      source: row.source
    })
    if (!current.symbol && row.symbol) {
      current.symbol = row.symbol
    }
    coins.set(tokenKey, current)
  }

  for (const coin of coins.values()) {
    coin.prices.sort((left, right) => left.timestamp - right.timestamp)
  }

  return coins
}
