const DAY = 86400
export function dateOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}
export function ranges(days: number[]): Array<{ start: string; end: string; days: number }> {
  const result: Array<{ start: string; end: string; days: number }> = []
  let previous = -Infinity
  for (const day of [...new Set(days)].sort((a, b) => a - b)) {
    if (day !== previous + DAY) result.push({ start: dateOf(day), end: dateOf(day), days: 1 })
    else {
      result[result.length - 1].end = dateOf(day)
      result[result.length - 1].days++
    }
    previous = day
  }
  return result
}
/** Classifies requested gaps only; never assumes an unexamined date is missing. */
export function classifyCoverage(missing: number[], available: number[], incomplete = false) {
  const sorted = [...new Set(available)].sort((a, b) => a - b)
  const first = sorted[0] ?? null
  const last = sorted.at(-1) ?? null
  const known = new Set(sorted)
  const categories: Record<string, number[]> = {}
  for (const day of [...new Set(missing)].sort((a, b) => a - b)) {
    const category = known.has(day)
      ? 'now-covered'
      : first == null
        ? 'no-observed-coverage'
        : day < first
          ? 'leading'
          : day > last!
            ? 'trailing'
            : 'interior'
    ;(categories[category] ??= []).push(day)
  }
  return {
    first,
    last,
    availableDays: sorted.length,
    incomplete,
    classifications: Object.keys(categories),
    gaps: Object.fromEntries(Object.entries(categories).map(([key, days]) => [key, ranges(days)]))
  }
}

/** Validate cached and fresh responses identically. An explicit null or broken
 * entry is a failed response, whereas an absent key is a successful miss. */
export function validateCoverageChart(response: unknown, coins: string[]): void {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Malformed chart')
  const entries = (response as { coins?: unknown }).coins
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('Malformed chart coins')
  for (const coin of coins) {
    if (!Object.hasOwn(entries, coin)) continue
    const entry = (entries as Record<string, unknown>)[coin]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Malformed chart entry')
    const samples = (entry as { prices?: unknown }).prices
    if (!Array.isArray(samples)) throw new Error('Malformed chart observations')
    const seen = new Map<number, number>()
    for (const sample of samples) {
      if (
        !sample ||
        !Number.isSafeInteger(sample.timestamp) ||
        sample.timestamp <= 0 ||
        !Number.isFinite(sample.price) ||
        sample.price <= 0
      )
        throw new Error('Malformed chart observation')
      if (seen.has(sample.timestamp) && seen.get(sample.timestamp) !== sample.price)
        throw new Error('Conflicting chart observations')
      seen.set(sample.timestamp, sample.price)
    }
  }
}
