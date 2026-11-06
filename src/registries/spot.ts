import { createCurveLpGuard, type PlausibleQuote } from '../sources/defillama/lp-guard'
import { getChainClient } from '../clients/rpc'
import { ApiError } from '../http/errors'
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
  return createMarketPriceResolver(marketSources, (chainId, token, _timestamp, signal) =>
    registry.resolve(chainId, token, signal)
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
      clientForChain: (chainId) => getChainClient(chainId, env)
    })
  ]
}

export class SpotSourceRegistry extends SourceRegistry<SpotPriceSource, [signal?: AbortSignal]> {
  constructor(sources: SpotPriceSource[], guard?: PlausibleQuote, env?: Env) {
    const plausible =
      guard ??
      createCurveLpGuard({
        clientForChain: (chainId) => getChainClient(chainId, env),
        coinPrices: async (chainId, coins) =>
          Promise.all(
            coins.map(async (coin) => {
              for (const source of sources) {
                if (!['enso', 'defillama'].includes(source.name) || !source.supports(chainId)) continue
                const quote = await source.getSpotPrice(chainId, coin)
                if (quote) return quote.price
              }
              return null
            })
          )
      })
    super(
      sources,
      'spot',
      async (source, chainId, token, signal) => {
        const price = await source.getSpotPrice(chainId, token, signal)
        if (
          price &&
          (source.name === 'enso' || source.name.startsWith('defillama')) &&
          !(await plausible(chainId, token, Math.floor(Date.now() / 1000), price.price))
        )
          return null
        return price
      },
      'No price available for this token'
    )
  }

  override resolve(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPrice> {
    return super.resolve(chainId, token, signal)
  }
}
