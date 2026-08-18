import { createHistoricalSources, HistoricalSourceRegistry } from './historical'
import { createSpotSources, SpotSourceRegistry } from './spot'
import type { Env } from '../types'

/**
 * One registry per request. The on-chain source hangs a single engine, block
 * cache and resolution budget off it, so every token in a request shares them
 * and nothing leaks into the next request.
 */
export function spotSourceRegistry(env: Env): SpotSourceRegistry {
  return new SpotSourceRegistry(createSpotSources(env))
}

export function historicalSourceRegistry(env?: Env): HistoricalSourceRegistry {
  return new HistoricalSourceRegistry(createHistoricalSources(env))
}

export { createHistoricalSources, createSpotSources, HistoricalSourceRegistry, SpotSourceRegistry }
export { SourceRegistry } from './source-registry'
export type { NamedSource, PriceFields, StampedPrice } from './source-registry'
