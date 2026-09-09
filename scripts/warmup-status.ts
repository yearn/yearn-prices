export const MAX_FAILURE_RATE = 0.1

export function isWarmupDegraded(stats: {
  attempts: number
  failures: number
  insertedDirect: number
  insertedCurve: number
  insertedDerived: number
}): boolean {
  const failureRate = stats.attempts > 0 ? stats.failures / stats.attempts : 0
  const inserted = stats.insertedDirect + stats.insertedCurve + stats.insertedDerived
  return failureRate > MAX_FAILURE_RATE || (stats.attempts > 0 && inserted === 0)
}
