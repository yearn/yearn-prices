import { isTodayNormalized } from './time'
import type { HistoricalRequestTuple } from './types'

// Decide whether warmCurveFallbackPrices should probe Curve for this request.
// Historical: only when neither a usable DefiLlama row nor a Curve row exists.
// Today: always refresh. Denylisted DefiLlama rows are already excluded by
// getExistingExactTimestamps(..., 'defillama'), so they appear missing here.
export function shouldAttemptCurveFallback(
  request: HistoricalRequestTuple,
  existingDefillama: ReadonlySet<string>,
  existingCurve: ReadonlySet<string>,
  now?: number,
): boolean {
  if (isTodayNormalized(request.timestamp, now)) {
    return true
  }

  const key = `${request.chain}:${request.token}:${request.timestamp}`
  return !existingDefillama.has(key) && !existingCurve.has(key)
}
