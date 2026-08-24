import { MAXIMUM_ACCEPTED_OFFSET_SECONDS } from './constants'

const MAXIMUM_SYMBOL_LENGTH = 64

export interface MatchOptions {
  maximumOffsetSeconds?: number
  isEligibleObservation?: (observedTimestamp: number) => boolean
}

export type MatchResult =
  | {
      kind: 'matched'
      price: number
      symbol: string | null
      confidence: number | null
      observedTimestamp: number
      offsetSeconds: number
    }
  | { kind: 'not_found' }
  | { kind: 'invalid_response' }

export function isObservationTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isObservationPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isValidSymbol(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= MAXIMUM_SYMBOL_LENGTH)
}

function isValidConfidence(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

export function matchChartObservation(coin: unknown, eodTimestamp: number, options: MatchOptions = {}): MatchResult {
  if (coin == null || typeof coin !== 'object' || Array.isArray(coin)) {
    return { kind: 'not_found' }
  }

  const entry = coin as Record<string, unknown>
  if (!Array.isArray(entry.prices) || !isValidSymbol(entry.symbol) || !isValidConfidence(entry.confidence)) {
    return { kind: 'invalid_response' }
  }

  const candidates = new Map<number, number>()

  for (const { timestamp, price } of windowEligibleObservations(coin, eodTimestamp, options)) {
    const collapsed = candidates.get(timestamp)
    if (collapsed !== undefined) {
      if (collapsed !== price) {
        return { kind: 'invalid_response' }
      }
      continue
    }
    candidates.set(timestamp, price)
  }

  let selected: { timestamp: number; price: number } | null = null
  for (const [timestamp, price] of candidates) {
    if (!selected) {
      selected = { timestamp, price }
      continue
    }

    const distance = Math.abs(timestamp - eodTimestamp)
    const selectedDistance = Math.abs(selected.timestamp - eodTimestamp)
    if (distance < selectedDistance || (distance === selectedDistance && timestamp < selected.timestamp)) {
      selected = { timestamp, price }
    }
  }

  if (!selected) {
    return { kind: 'not_found' }
  }

  return {
    kind: 'matched',
    price: selected.price,
    symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    observedTimestamp: selected.timestamp,
    offsetSeconds: selected.timestamp - eodTimestamp
  }
}

export function windowEligibleObservations(
  coin: unknown,
  eodTimestamp: number,
  options: MatchOptions = {}
): Array<{ timestamp: number; price: number }> {
  if (coin == null || typeof coin !== 'object' || Array.isArray(coin)) {
    return []
  }

  const entry = coin as Record<string, unknown>
  if (!Array.isArray(entry.prices)) {
    return []
  }

  const maximumOffsetSeconds = options.maximumOffsetSeconds ?? MAXIMUM_ACCEPTED_OFFSET_SECONDS
  const observations: Array<{ timestamp: number; price: number }> = []

  for (const raw of entry.prices) {
    if (raw == null || typeof raw !== 'object') {
      continue
    }

    const observation = raw as Record<string, unknown>
    const { timestamp, price } = observation
    if (!isObservationTimestamp(timestamp) || !isObservationPrice(price)) {
      continue
    }
    if (Math.abs(timestamp - eodTimestamp) > maximumOffsetSeconds) {
      continue
    }
    if (options.isEligibleObservation && !options.isEligibleObservation(timestamp)) {
      continue
    }

    observations.push({ timestamp, price })
  }

  return observations
}
