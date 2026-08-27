import { type Address, type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp, getChainClient } from '../../clients/rpc'
import { ApiError } from '../../http/errors'
import type { Env } from '../../types'
import { HistoricalPriceSourceBase } from '../base'
import { type ClientForChain, maybe } from '../onchain/context'
import type { HistoricalPriceResult } from '../types'
import { getChainlinkFeed, hasChainlinkFeeds } from './feeds'

// 2x the longest heartbeat among the feeds in feeds.ts (86,400s daily USD
// feeds): a healthy feed reaches its heartbeat age before the next update.
const MAX_STALENESS_SECONDS = 172_800

const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)'
])

export type ChainlinkClientForChain = ClientForChain

export interface ChainlinkHistoricalSourceOptions {
  clientForChain?: ChainlinkClientForChain
  env?: Env
}

export class ChainlinkHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'chainlink'
  readonly priority = 15

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

    // A transport failure must not escape raw: its message embeds the RPC url,
    // api key included, and the worker logs it and answers 500 instead of 503.
    try {
      return await this.readFeed(client, chainId, feed, timestamp)
    } catch (error) {
      throw new ApiError('UNAVAILABLE', `Chainlink read failed on chain ${chainId} (${errorName(error)})`)
    }
  }

  private async readFeed(
    client: PublicClient,
    chainId: number,
    feed: Address,
    timestamp: number
  ): Promise<HistoricalPriceResult | null> {
    const blockNumber = await estimateBlockByTimestamp(client, chainId, timestamp)

    const block = await client.getBlock({ blockNumber })

    // A feed that reverts at this block is not deployed yet: let another
    // source answer instead of failing the whole request.
    const reads = await maybe(() =>
      Promise.all([
        client.readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber }),
        client.readContract({ address: feed, abi: FEED_ABI, functionName: 'decimals', blockNumber })
      ])
    )
    if (!reads) {
      return null
    }

    const [roundData, decimals] = reads

    const updatedAt = Number(roundData[3])
    if (updatedAt + MAX_STALENESS_SECONDS < Number(block.timestamp)) {
      return null
    }

    const price = Number(roundData[1]) / 10 ** Number(decimals)
    if (!this.isUsablePrice(price, updatedAt)) {
      return null
    }

    // The feed prices an asset, not this token key: naming its base asset here
    // would relabel WPOL as MATIC depending on which source answered.
    return { price, timestamp: updatedAt, symbol: null, confidence: null }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}

export function createChainlinkHistoricalSource(
  options: ChainlinkHistoricalSourceOptions = {}
): ChainlinkHistoricalSource {
  return new ChainlinkHistoricalSource(options)
}
