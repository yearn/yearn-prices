import { type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp, getChainClient } from '../../clients/rpc'
import type { Env } from '../../types'
import { HistoricalPriceSourceBase } from '../base'
import { maybe } from '../onchain/context'
import type { HistoricalPriceResult } from '../types'
import { toHistoricalPrice } from './coin'
import { getChainlinkFeed, hasChainlinkFeeds } from './feeds'

const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)'
])

export type ChainlinkClientForChain = (chainId: number) => PublicClient | null

export interface ChainlinkHistoricalSourceOptions {
  clientForChain?: ChainlinkClientForChain
  env?: Env
}

export class ChainlinkHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'chainlink'
  readonly priority = 20

  private readonly clientForChain: ChainlinkClientForChain

  constructor(options: ChainlinkHistoricalSourceOptions = {}) {
    super()
    this.clientForChain = options.clientForChain ?? ((chainId) => getChainClient(chainId, options.env))
  }

  supports(chainId: number): boolean {
    return hasChainlinkFeeds(chainId) && this.clientForChain(chainId) !== null
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    const client = this.clientForChain(chainId)
    if (!client) {
      return null
    }

    const feed = getChainlinkFeed(chainId, token)
    if (!feed) {
      return null
    }

    const blockNumber = await estimateBlockByTimestamp(client, chainId, timestamp)

    // A feed that reverts at this block is not deployed yet: let another
    // source answer instead of failing the whole request.
    const reads = await maybe(() =>
      Promise.all([
        client.readContract({ address: feed.address, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber }),
        client.readContract({ address: feed.address, abi: FEED_ABI, functionName: 'decimals', blockNumber }),
        client.getBlock({ blockNumber })
      ])
    )
    if (!reads) {
      return null
    }

    const [roundData, decimals, block] = reads

    return toHistoricalPrice(
      roundData[1],
      Number(decimals),
      roundData[3],
      block.timestamp,
      feed.symbol,
      (price, observedAt) => this.isUsablePrice(price, observedAt)
    )
  }
}

export function createChainlinkHistoricalSource(
  options: ChainlinkHistoricalSourceOptions = {}
): ChainlinkHistoricalSource {
  return new ChainlinkHistoricalSource(options)
}
