import { DEFI_LLAMA_SEARCH_WIDTH, DefiLlamaClient } from '../../clients/defillama'
import { chainIdToName } from '../../utils/chains'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalPriceResult } from '../types'
import { DEFI_LLAMA_ALIAS_CHAINS, getDefiLlamaCoinGeckoAlias, isDefiLlamaAliasValidAt } from './aliases'
import { toHistoricalPrice } from './coin'

const SEARCH_WIDTH_PATTERN = /^(\d+)(s|m|h|d)$/
const UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const

function searchWidthSeconds(searchWidth: string): number | null {
  const match = SEARCH_WIDTH_PATTERN.exec(searchWidth)
  if (!match) {
    return null
  }
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS]
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

/**
 * Last-resort historical source for tokens DeFiLlama does not price by
 * contract address. Each token is mapped to the CoinGecko market of the asset
 * it represents, and only inside the window where that mapping holds: a
 * bridged token stops being a proxy for its canonical asset once the bridge
 * is impaired.
 */
export class DefiLlamaAliasHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'defillama-alias'
  readonly priority = 30

  private readonly widthSeconds: number

  constructor(
    private readonly client: DefiLlamaClient = new DefiLlamaClient(),
    private readonly searchWidth = DEFI_LLAMA_SEARCH_WIDTH
  ) {
    super()
    const widthSeconds = searchWidthSeconds(searchWidth)
    if (widthSeconds == null) {
      throw new Error(`Invalid DeFiLlama searchWidth: ${searchWidth}`)
    }
    this.widthSeconds = widthSeconds
  }

  supports(chainId: number): boolean {
    const chain = chainIdToName(chainId)
    return chain !== undefined && DEFI_LLAMA_ALIAS_CHAINS.has(chain)
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    const chain = chainIdToName(chainId)
    if (!chain) {
      return null
    }

    const alias = getDefiLlamaCoinGeckoAlias(chain, token)
    if (!alias || !isDefiLlamaAliasValidAt(alias, timestamp)) {
      return null
    }

    const response = await this.client.getHistorical(timestamp, [alias.identifier], this.searchWidth)
    const coin = Object.entries(response.coins ?? {}).find(
      ([key]) => key.toLowerCase() === alias.identifier.toLowerCase()
    )?.[1]

    const price = toHistoricalPrice(coin, (value, time) => this.isUsablePrice(value, time))
    if (!price) {
      return null
    }

    // The provider ignores searchWidth for some markets; an observation
    // outside the window is a different day's price, not this one's.
    if (Math.abs(price.timestamp - timestamp) > this.widthSeconds) {
      return null
    }
    if (!isDefiLlamaAliasValidAt(alias, price.timestamp)) {
      return null
    }

    return price
  }
}

export function createDefiLlamaAliasHistoricalSource(
  client?: DefiLlamaClient,
  searchWidth?: string
): DefiLlamaAliasHistoricalSource {
  return new DefiLlamaAliasHistoricalSource(client, searchWidth)
}
