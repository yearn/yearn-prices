import { isTodayNormalized } from './time'

export const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable'
export const CACHE_CONTROL_TODAY = 'public, max-age=3600, stale-while-revalidate=14400'
export const CACHE_CONTROL_PARTIAL = 'public, max-age=3600'
export const CACHE_CONTROL_NOT_FOUND = 'public, max-age=3600, stale-while-revalidate=14400'

export function cacheControlForHistorical(timestamp: number): string {
  return isTodayNormalized(timestamp) ? CACHE_CONTROL_TODAY : CACHE_CONTROL_IMMUTABLE
}

export function cacheControlForBatch(timestamps: number[], allResolved: boolean): string {
  if (timestamps.some(timestamp => isTodayNormalized(timestamp))) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_PARTIAL
}

export function cacheControlForRange(rangeEnds: number[], allResolved: boolean): string {
  if (rangeEnds.some(timestamp => isTodayNormalized(timestamp))) {
    return CACHE_CONTROL_TODAY
  }

  return allResolved ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_PARTIAL
}
