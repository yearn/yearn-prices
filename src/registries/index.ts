import { getHistoricalSourceRegistry, HistoricalSourceRegistry, resetHistoricalSourceRegistry } from './historical'
import { getSpotSourceRegistry, resetSpotSourceRegistry, SpotSourceRegistry } from './spot'

export function resetSourceRegistries(): void {
  resetSpotSourceRegistry()
  resetHistoricalSourceRegistry()
}

export type { NamedSource, PriceFields, StampedPrice } from './source-registry'
export { SourceRegistry } from './source-registry'
export {
  getHistoricalSourceRegistry,
  getSpotSourceRegistry,
  HistoricalSourceRegistry,
  resetHistoricalSourceRegistry,
  resetSpotSourceRegistry,
  SpotSourceRegistry
}
