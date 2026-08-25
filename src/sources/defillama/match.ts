export interface DefiLlamaSample {
  timestamp: number
  price: number
  confidence?: number | null
}

export const DEFI_LLAMA_SEARCH_WIDTH_SECONDS = 15 * 60
export const DEFI_LLAMA_FETCH_WIDTH_SECONDS = 6 * 60 * 60

function assignNearestSamples<T extends DefiLlamaSample>(
  requestedTimestamps: number[],
  samples: T[],
  maxDeltaSeconds: number,
  matched: Map<number, T>,
  usedSamples: Set<number>
): void {
  const pairs: Array<{ requested: number; sampleIndex: number; delta: number }> = []

  for (const requested of requestedTimestamps) {
    if (matched.has(requested)) {
      continue
    }
    for (const [sampleIndex, sample] of samples.entries()) {
      if (usedSamples.has(sampleIndex) || !Number.isFinite(sample.timestamp) || !Number.isFinite(sample.price)) {
        continue
      }
      const delta = Math.abs(sample.timestamp - requested)
      if (delta <= maxDeltaSeconds) {
        pairs.push({ requested, sampleIndex, delta })
      }
    }
  }

  pairs.sort((a, b) => a.delta - b.delta || a.requested - b.requested || a.sampleIndex - b.sampleIndex)

  for (const pair of pairs) {
    if (matched.has(pair.requested) || usedSamples.has(pair.sampleIndex)) {
      continue
    }
    matched.set(pair.requested, samples[pair.sampleIndex])
    usedSamples.add(pair.sampleIndex)
  }
}

export function matchPricesToRequests<T extends DefiLlamaSample>(
  requestedTimestamps: number[],
  samples: T[]
): Map<number, T> {
  const matched = new Map<number, T>()
  const usedSamples = new Set<number>()

  assignNearestSamples(requestedTimestamps, samples, DEFI_LLAMA_SEARCH_WIDTH_SECONDS, matched, usedSamples)
  assignNearestSamples(requestedTimestamps, samples, DEFI_LLAMA_FETCH_WIDTH_SECONDS, matched, usedSamples)

  return matched
}
