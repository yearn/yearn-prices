export type ChartEnvelope = { kind: 'coin'; coin: unknown } | { kind: 'missing' } | { kind: 'invalid' }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function readChartCoin(response: unknown, identifier: string): ChartEnvelope {
  if (!isPlainRecord(response)) {
    return { kind: 'invalid' }
  }

  const coins = response.coins
  if (!isPlainRecord(coins)) {
    return { kind: 'invalid' }
  }

  if (!Object.hasOwn(coins, identifier)) {
    return { kind: 'missing' }
  }

  return { kind: 'coin', coin: coins[identifier] }
}
