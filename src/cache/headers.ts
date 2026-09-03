import { isClosedDay, isTodayNormalized } from '../utils/time'

export const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable'
// Today's value changes intraday as warmup (hourly) backfills it. s-maxage=300 lets the
// shared edge refresh every ~5min — far tighter than the warmup cadence — while browsers
// keep the gentler 1h max-age.
export const CACHE_CONTROL_TODAY = 'public, s-maxage=300, max-age=3600, stale-while-revalidate=14400'
export const CACHE_CONTROL_PARTIAL = 'public, max-age=3600'
// A historical miss means the row is not in the table yet, not that no price exists:
// the hourly warmup or a gap backfill can fill it at any time. Keep the negative TTL
// under the warmup cadence so a client stops seeing 404 soon after the row lands.
export const CACHE_CONTROL_NOT_FOUND = 'public, s-maxage=300, max-age=300'
// Spot is a live proxy with no upstream cache policy. Short shared-cache TTL so the
// edge absorbs bursts without serving long-stale prices; mirrors yearn.fi's Enso proxy.
export const CACHE_CONTROL_SPOT = 'public, s-maxage=120, stale-while-revalidate=600'
// Generic error responses set this so no client or shared cache retains them. (Errors
// also never reach writeEdgeCache — they return from the request handler's catch block —
// so they don't populate the edge cache regardless.) Historical not-found is the one
// deliberate exception: it returns a short-lived negative result (CACHE_CONTROL_NOT_FOUND).
export const CACHE_CONTROL_NO_STORE = 'no-store'

export function cacheControlForHistorical(timestamp: number): string {
  return isTodayNormalized(timestamp) ? CACHE_CONTROL_TODAY : CACHE_CONTROL_IMMUTABLE
}

export function cacheControlForBatch(timestamps: number[], allResolved: boolean): string {
  if (timestamps.some((timestamp) => !isClosedDay(timestamp))) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_PARTIAL
}

export function cacheControlForRange(rangeEnds: number[], allResolved: boolean): string {
  if (rangeEnds.some((timestamp) => isTodayNormalized(timestamp))) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_PARTIAL
}
