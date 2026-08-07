import {
  getHistoricalSourceRegistry,
  HistoricalSourceRegistry,
  resetHistoricalSourceRegistry,
} from './historical'
import {
  getSpotSourceRegistry,
  resetSpotSourceRegistry,
  SpotSourceRegistry,
} from './spot'

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
  SpotSourceRegistry,
}
