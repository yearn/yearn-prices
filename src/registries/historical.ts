import { DefiLlamaClient } from '../clients/defillama'
import { createDefiLlamaHistoricalSource } from '../sources'
import type { HistoricalPrice, HistoricalPriceSource } from '../sources/types'
import type { Env } from '../types'

import { SourceRegistry } from './source-registry'

export function createHistoricalSources(_env?: Env): HistoricalPriceSource[] {
  return [createDefiLlamaHistoricalSource(new DefiLlamaClient())]
}

export class HistoricalSourceRegistry extends SourceRegistry<
  HistoricalPriceSource,
  [timestamp: number]
> {
  constructor(sources: HistoricalPriceSource[]) {
    super(
      sources,
      'historical',
      (source, chainId, token, timestamp) =>
        source.getHistoricalPrice(chainId, token, timestamp),
      'No historical price available for this token',
    )
  }

  override resolve(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPrice> {
    return super.resolve(chainId, token, timestamp)
  }
}

let historicalRegistryInstance: HistoricalSourceRegistry | null = null

export function getHistoricalSourceRegistry(env?: Env): HistoricalSourceRegistry {
  if (!historicalRegistryInstance) {
    historicalRegistryInstance = new HistoricalSourceRegistry(createHistoricalSources(env))
  }
  return historicalRegistryInstance
}

export function resetHistoricalSourceRegistry(): void {
  historicalRegistryInstance = null
}
