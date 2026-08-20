import type { Pool } from '@neondatabase/serverless'
import type { Env } from '../types'
import { createHistoricalSources, HistoricalSourceRegistry } from './historical'
import { createSpotSources, SpotSourceRegistry } from './spot'

/**
 * One registry per request. The on-chain source hangs a single engine, block
 * cache and resolution budget off it, so every token in a request shares them
 * and nothing leaks into the next request.
 */
export function spotSourceRegistry(env: Env): SpotSourceRegistry {
  return new SpotSourceRegistry(createSpotSources(env))
}

export function historicalSourceRegistry(env?: Env, pool?: Pool): HistoricalSourceRegistry {
  return new HistoricalSourceRegistry(createHistoricalSources(env, pool))
}

export type { NamedSource, PriceFields, StampedPrice } from './source-registry'
export { SourceRegistry } from './source-registry'
export { createHistoricalSources, createSpotSources, HistoricalSourceRegistry, SpotSourceRegistry }
