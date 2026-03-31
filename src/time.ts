const DAY_SECONDS = 86_400

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

export function normalizeToEndOfDay(timestamp: number): number {
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid timestamp: ${timestamp}`)
  }

  return Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS + (DAY_SECONDS - 1)
}

export function currentUtcDayEnd(now = nowUnix()): number {
  return normalizeToEndOfDay(now)
}

export function isTodayNormalized(timestamp: number, now = nowUnix()): boolean {
  return normalizeToEndOfDay(timestamp) === currentUtcDayEnd(now)
}

export function normalizedRangeDayCount(startTimestamp: number, endTimestamp: number): number {
  return Math.floor((endTimestamp - startTimestamp) / DAY_SECONDS) + 1
}

export function normalizedDaysInRange(startTimestamp: number, endTimestamp: number): number[] {
  const timestamps: number[] = []
  for (let cursor = startTimestamp; cursor <= endTimestamp; cursor += DAY_SECONDS) {
    timestamps.push(cursor)
  }
  return timestamps
}

export function unixToIsoTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString()
}

export function pgTimestampToUnix(value: string | Date): number {
  const date = value instanceof Date ? value : new Date(value)
  return Math.floor(date.getTime() / 1000)
}

export function parseCliDate(value: string): number {
  if (/^\d+$/.test(value)) {
    return normalizeToEndOfDay(Number(value))
  }

  const parsed = new Date(`${value}T23:59:59.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date value: ${value}`)
  }

  return Math.floor(parsed.getTime() / 1000)
}
