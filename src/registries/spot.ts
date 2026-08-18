import { ApiError } from '../http/errors'
import { getChainClient } from '../clients/rpc'
import { createEnsoSpotSource } from '../sources'
import { createOnchainSpotSource } from '../sources/onchain'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env } from '../types'

import { createMarketPriceResolver } from './market-price'
import { SourceRegistry } from './source-registry'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: SpotPriceSource[]) {
  const registry = new SpotSourceRegistry(marketSources)
  return createMarketPriceResolver(marketSources, (chainId, token) =>
    registry.resolve(chainId, token),
  )
}

export function createSpotSources(env: Env): SpotPriceSource[] {
  if (!env.ENSO_API_KEY) {
    throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  }

  const marketSources = [createEnsoSpotSource(env.ENSO_API_KEY)]

  return [
    ...marketSources,
    createOnchainSpotSource({
      marketPrice: marketPriceResolver(marketSources),
      env,
      clientForChain: (chainId) => getChainClient(chainId, env),
    }),
  ]
}

export class SpotSourceRegistry extends SourceRegistry<SpotPriceSource> {
  constructor(sources: SpotPriceSource[]) {
    super(
      sources,
      'spot',
      (source, chainId, token) => source.getSpotPrice(chainId, token),
      'No price available for this token',
    )
  }

  override resolve(chainId: number, token: string): Promise<SpotPrice> {
    return super.resolve(chainId, token)
  }
}
