import type { Pool } from '@neondatabase/serverless'
import { DefiLlamaClient } from '../clients/defillama'
import { getChainClient } from '../clients/rpc'
import { createDefiLlamaAliasHistoricalSource, createDefiLlamaHistoricalSource } from '../sources'
import { createDbHistoricalSource } from '../sources/db/historical'
import { createOnchainHistoricalSource } from '../sources/onchain'
import type { HistoricalPrice, HistoricalPriceSource } from '../sources/types'
import type { Env } from '../types'

import { createMarketPriceResolver } from './market-price'
import { SourceRegistry } from './source-registry'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
export function marketPriceResolver(marketSources: HistoricalPriceSource[]) {
  const registry = new HistoricalSourceRegistry(marketSources)
  return createMarketPriceResolver(
    marketSources,
    (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
    { requireTimestamp: true }
  )
}

/**
 * The child market source list: DB first, then DefiLlama, then DefiLlama alias.
 * Shared by the registry and the backfill script so the order lives in one place.
 */
export function createChildMarketSources(client: DefiLlamaClient, pool?: Pool): HistoricalPriceSource[] {
  return [
    ...(pool ? [createDbHistoricalSource(pool)] : []),
    createDefiLlamaHistoricalSource(client),
    createDefiLlamaAliasHistoricalSource(client)
  ]
}

export function createHistoricalSources(env?: Env, pool?: Pool): HistoricalPriceSource[] {
  const client = new DefiLlamaClient()
  const rootMarketSources = [createDefiLlamaHistoricalSource(client), createDefiLlamaAliasHistoricalSource(client)]

  return [
    ...rootMarketSources,
    createOnchainHistoricalSource({
      marketPrice: marketPriceResolver(createChildMarketSources(client, pool)),
      env,
      clientForChain: (chainId) => getChainClient(chainId, env)
    })
  ]
}

export class HistoricalSourceRegistry extends SourceRegistry<HistoricalPriceSource, [timestamp: number]> {
  constructor(sources: HistoricalPriceSource[]) {
    super(
      sources,
      'historical',
      (source, chainId, token, timestamp) => source.getHistoricalPrice(chainId, token, timestamp),
      'No historical price available for this token'
    )
  }

  override resolve(chainId: number, token: string, timestamp: number): Promise<HistoricalPrice> {
    return super.resolve(chainId, token, timestamp)
  }
}
