import { getHistoricalSourceRegistry, HistoricalSourceRegistry, resetHistoricalSourceRegistry } from './historical'
import { getSpotSourceRegistry, resetSpotSourceRegistry, SpotSourceRegistry } from './spot'

export function resetSourceRegistries(): void {
  resetSpotSourceRegistry()
  resetHistoricalSourceRegistry()
}

export {
  getHistoricalSourceRegistry,
  getSpotSourceRegistry,
  HistoricalSourceRegistry,
  resetHistoricalSourceRegistry,
  resetSpotSourceRegistry,
  SpotSourceRegistry
}
export { SourceRegistry } from './source-registry'
export type { NamedSource, PriceFields, StampedPrice } from './source-registry'
