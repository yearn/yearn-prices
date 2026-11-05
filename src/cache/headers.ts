import { currentUtcDayEnd, normalizeToEndOfDay } from '../utils/time'

// Historical rows can be repaired, but repairs invalidate the edge by bumping
// HISTORICAL_CACHE_REVISION. Keep closed days at the edge for 30 days.
export const CACHE_CONTROL_HISTORICAL = 'public, s-maxage=2592000, max-age=3600'
// Today is always read live from DeFiLlama /prices/current (readThrough), so the served price is
// at most one edge TTL old; a 60s edge and browser TTL bounds that staleness.
export const CACHE_CONTROL_TODAY = 'public, s-maxage=60, max-age=60, stale-while-revalidate=300'
// A closed-day miss is filled on read from DeFiLlama /batchHistorical and persisted (readThrough).
// A remaining 404, or a pair omitted from a batch/range, means upstream had no price or the
// per-request read-through cap was hit; warmup or a backfill can still fill it. Keep both negative
// TTLs under the warmup cadence. CACHE_CONTROL_PARTIAL only reaches responses made entirely of
// closed days: a batch/range touching today takes CACHE_CONTROL_TODAY before the partial check runs.
export const CACHE_CONTROL_PARTIAL = 'public, s-maxage=300, max-age=300'
export const CACHE_CONTROL_NOT_FOUND = 'public, s-maxage=300, max-age=300'
// Spot is a live proxy with no upstream cache policy. Short shared-cache TTL so the
// edge absorbs bursts without serving long-stale prices; mirrors yearn.fi's Enso proxy.
export const CACHE_CONTROL_SPOT = 'public, s-maxage=120, stale-while-revalidate=600'
// Generic error responses set this so no client or shared cache retains them. (Errors
// also never reach writeEdgeCache — they return from the request handler's catch block —
// so they don't populate the edge cache regardless.) Historical not-found is the one
// deliberate exception: it returns a short-lived negative result (CACHE_CONTROL_NOT_FOUND).
export const CACHE_CONTROL_NO_STORE = 'no-store'

function mayBeProvisional(timestamp: number): boolean {
  return normalizeToEndOfDay(timestamp) >= currentUtcDayEnd() - 86_400
}

export function cacheControlForHistorical(timestamp: number): string {
  return mayBeProvisional(timestamp) ? CACHE_CONTROL_TODAY : CACHE_CONTROL_HISTORICAL
}

export function cacheControlForBatch(timestamps: number[], allResolved: boolean): string {
  if (timestamps.some(mayBeProvisional)) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_HISTORICAL : CACHE_CONTROL_PARTIAL
}

export function cacheControlForRange(rangeEnds: number[], allResolved: boolean): string {
  if (rangeEnds.some(mayBeProvisional)) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_HISTORICAL : CACHE_CONTROL_PARTIAL
}
