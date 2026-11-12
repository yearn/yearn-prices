import { getChainClient } from '../clients/rpc'
import { createChainlinkSpotSource, createDefiLlamaSpotSource, createEnsoSpotSource } from '../sources'
import { createCurveLpGuard, type PlausibleQuote } from '../sources/defillama/lp-guard'
import { createOnchainSpotSource } from '../sources/onchain'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env } from '../types'

import { createMarketPriceResolver } from './market-price'
import { SourceRegistry } from './source-registry'

const isGuardedSource = (source: SpotPriceSource) => source.name === 'enso' || source.name === 'defillama'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: SpotPriceSource[], env: Env) {
  const registry = new SpotSourceRegistry(marketSources, async () => true, env)
  return createMarketPriceResolver(marketSources, (chainId, token, _timestamp, signal) =>
    registry.resolve(chainId, token, signal)
  )
}

export function createSpotSources(env: Env): SpotPriceSource[] {
  const directEnv = {
    ...env,
    PRICE_GATEWAY_URL: undefined,
    PRICE_PROXY_URLS: undefined,
    PRICE_PROXY_LIST_URLS: undefined,
    PRICE_PROXY_PUBLIC_LIST: undefined
  } as Env
  const marketSources: SpotPriceSource[] = []
  // Enso is an accelerator, not a prerequisite for the independent sources.
  // A missing key must leave DeFiLlama, Chainlink and on-chain derivation usable.
  if (env.ENSO_API_KEY) marketSources.push(createEnsoSpotSource(env.ENSO_API_KEY, directEnv))
  marketSources.push(createDefiLlamaSpotSource(undefined, directEnv), createChainlinkSpotSource({ env }))

  return [
    ...marketSources,
    createOnchainSpotSource({
      marketPrice: marketPriceResolver(marketSources, env),
      env,
      clientForChain: (chainId) => getChainClient(chainId, env)
    })
  ]
}

export class SpotSourceRegistry extends SourceRegistry<SpotPriceSource, [signal?: AbortSignal, guarded?: boolean]> {
  constructor(sources: SpotPriceSource[], guard?: PlausibleQuote, env?: Env) {
    const timestamp = Math.floor(Date.now() / 1000)
    const blocks = new Map<number, Promise<bigint>>()
    const plausible =
      guard ??
      createCurveLpGuard({
        clientForChain: (chainId) => getChainClient(chainId, env),
        blockForTimestamp: function currentSpotBlock(client, chainId) {
          let block = blocks.get(chainId)
          if (!block) {
            block = client.getBlockNumber()
            blocks.set(chainId, block)
            block.catch(() => blocks.delete(chainId))
          }
          return block
        },
        coinPrices: async (chainId, coins) =>
          Promise.all(
            coins.map(async (coin) => {
              for (const source of sources) {
                if (!isGuardedSource(source) || !source.supports(chainId)) continue
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
      async (source, chainId, token, signal, guarded = true) => {
        const price = await source.getSpotPrice(chainId, token, signal)
        if (price && guarded && isGuardedSource(source) && !(await plausible(chainId, token, timestamp, price.price)))
          return null
        return price
      },
      'No price available for this token'
    )
  }

  override resolve(chainId: number, token: string, signal?: AbortSignal, guarded?: boolean): Promise<SpotPrice> {
    return super.resolve(chainId, token, signal, guarded)
  }
}
