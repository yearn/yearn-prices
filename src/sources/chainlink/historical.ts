import { type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp, getChainClient } from '../../clients/rpc'
import type { Env } from '../../types'
import { HistoricalPriceSourceBase } from '../base'
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

type ChainlinkHistoricalSourceInput = ChainlinkHistoricalSourceOptions | ChainlinkClientForChain

function normalizeOptions(input: ChainlinkHistoricalSourceInput): ChainlinkHistoricalSourceOptions {
  return typeof input === 'function' ? { clientForChain: input } : input
}

function clientResolver(options: ChainlinkHistoricalSourceOptions): ChainlinkClientForChain {
  return options.clientForChain ?? ((chainId) => getChainClient(chainId, options.env))
}

export class ChainlinkHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'chainlink'
  readonly priority = 20

  private readonly clientForChain: ChainlinkClientForChain

  constructor(input: ChainlinkHistoricalSourceInput = {}) {
    super()
    const options = normalizeOptions(input)
    this.clientForChain = clientResolver(options)
  }

  supports(chainId: number): boolean {
    return this.clientForChain(chainId) !== null && hasChainlinkFeeds(chainId)
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    const client = this.clientForChain(chainId)
    if (!client || !hasChainlinkFeeds(chainId)) {
      return null
    }

    const feed = getChainlinkFeed(chainId, token)
    if (!feed) {
      return null
    }

    const blockNumber = await estimateBlockByTimestamp(client, chainId, timestamp)

    const [roundData, decimals, block] = await Promise.all([
      client.readContract({ address: feed.address, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber }),
      client.readContract({ address: feed.address, abi: FEED_ABI, functionName: 'decimals', blockNumber }),
      client.getBlock({ blockNumber })
    ])

    return toHistoricalPrice(
      roundData[1],
      Number(decimals),
      roundData[3],
      block.timestamp,
      feed.symbol || null,
      (price, observedAt) => this.isUsablePrice(price, observedAt)
    )
  }
}

export function createChainlinkHistoricalSource(input: ChainlinkHistoricalSourceInput = {}): ChainlinkHistoricalSource {
  return new ChainlinkHistoricalSource(input)
}
