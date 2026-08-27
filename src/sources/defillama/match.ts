import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS } from '../../clients/defillama'
import type { TokenPriceWrite } from '../../types'
import { normalizeToEndOfDay } from '../../utils'

export interface DefiLlamaSample {
  timestamp: number
  price: number
  confidence?: number | null
}

/** Strict pass: a sample this close to midnight is that day's close, not a neighbour's. */
export const DEFI_LLAMA_STRICT_MATCH_SECONDS = 15 * 60

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

  assignNearestSamples(requestedTimestamps, samples, DEFI_LLAMA_STRICT_MATCH_SECONDS, matched, usedSamples)
  assignNearestSamples(requestedTimestamps, samples, DEFI_LLAMA_SEARCH_WIDTH_SECONDS, matched, usedSamples)

  return matched
}

export interface DefiLlamaCoinResponse {
  symbol?: string | null
  prices?: DefiLlamaSample[]
}

/**
 * Keys every write by the day that was requested, not by the sample's own
 * timestamp: a sample minutes either side of midnight belongs to the day we
 * asked for.
 */
export function buildDefiLlamaWrites(
  chain: string,
  token: string,
  requestedTimestamps: number[],
  coin: DefiLlamaCoinResponse | undefined
): { writes: TokenPriceWrite[]; missing: number[] } {
  const matched = matchPricesToRequests(requestedTimestamps, coin?.prices ?? [])
  const writes: TokenPriceWrite[] = []
  const missing: number[] = []

  for (const requested of requestedTimestamps) {
    const sample = matched.get(requested)
    if (!sample) {
      missing.push(requested)
      continue
    }
    writes.push({
      chain,
      token,
      timestamp: normalizeToEndOfDay(requested),
      price: sample.price,
      symbol: coin?.symbol ?? null,
      confidence: sample.confidence ?? null,
      source: 'defillama'
    })
  }

  return { writes, missing }
}
