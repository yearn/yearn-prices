import { normalizeToEndOfDay } from '../../utils/time'

export interface DefiLlamaSample {
  timestamp: number
  price: number
  confidence?: number | null
}

export const DEFI_LLAMA_SEARCH_WIDTH_SECONDS = 15 * 60

export function matchPricesToRequests<T extends DefiLlamaSample>(
  requestedTimestamps: number[],
  samples: T[],
  maxDeltaSeconds = DEFI_LLAMA_SEARCH_WIDTH_SECONDS
): Map<number, T> {
  const pairs: Array<{ requested: number; sampleIndex: number; delta: number }> = []

  for (const requested of requestedTimestamps) {
    for (const [sampleIndex, sample] of samples.entries()) {
      if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.price)) {
        continue
      }
      const delta = Math.abs(sample.timestamp - requested)
      if (delta <= maxDeltaSeconds) {
        pairs.push({ requested, sampleIndex, delta })
      }
    }
  }

  pairs.sort((a, b) => a.delta - b.delta || a.requested - b.requested || a.sampleIndex - b.sampleIndex)

  const matched = new Map<number, T>()
  const usedSamples = new Set<number>()

  for (const pair of pairs) {
    if (matched.has(pair.requested) || usedSamples.has(pair.sampleIndex)) {
      continue
    }
    matched.set(pair.requested, samples[pair.sampleIndex])
    usedSamples.add(pair.sampleIndex)
  }

  for (const requested of requestedTimestamps) {
    if (matched.has(requested)) {
      continue
    }
    const requestedDay = normalizeToEndOfDay(requested)
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (const [sampleIndex, sample] of samples.entries()) {
      if (usedSamples.has(sampleIndex) || !Number.isFinite(sample.timestamp) || !Number.isFinite(sample.price)) {
        continue
      }
      if (normalizeToEndOfDay(sample.timestamp) !== requestedDay) {
        continue
      }
      const delta = Math.abs(sample.timestamp - requested)
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = sampleIndex
      }
    }
    if (bestIndex !== -1) {
      matched.set(requested, samples[bestIndex])
      usedSamples.add(bestIndex)
    }
  }

  return matched
}
