import { DefiLlamaClient } from '../clients/defillama'
import { getChainClient } from '../clients/rpc'
import { createDefiLlamaHistoricalSource } from '../sources'
import { createOnchainHistoricalSource } from '../sources/onchain'
import type { HistoricalPrice, HistoricalPriceSource } from '../sources/types'
import type { Env } from '../types'

import { createMarketPriceResolver } from './market-price'
import { SourceRegistry } from './source-registry'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: HistoricalPriceSource[]) {
  const registry = new HistoricalSourceRegistry(marketSources)
  return createMarketPriceResolver(
    marketSources,
    (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
    { requireTimestamp: true },
  )
}

export function createHistoricalSources(env?: Env): HistoricalPriceSource[] {
  const marketSources = [createDefiLlamaHistoricalSource(new DefiLlamaClient())]

  return [
    ...marketSources,
    createOnchainHistoricalSource({
      marketPrice: marketPriceResolver(marketSources),
      env,
      clientForChain: (chainId) => getChainClient(chainId, env),
    }),
  ]
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
