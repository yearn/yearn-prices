import { type Address, type PublicClient, parseAbi, zeroAddress } from 'viem'
import { getChainClient } from '../../clients/rpc'
import { ApiError } from '../../http/errors'
import type { Env } from '../../types'
import { HistoricalPriceSourceBase } from '../base'
import { type ClientForChain, maybe } from '../onchain/context'
import type { HistoricalPriceResult } from '../types'
import { getChainlinkFeed, hasChainlinkFeeds } from './feeds'

// 2x the longest heartbeat among the feeds in feeds.ts (86,400s daily USD
// feeds): a healthy feed reaches its heartbeat age before the next update.
const MAX_STALENESS_SECONDS = 172_800
const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n
const PHASE_SHIFT = 64n
const MAX_ROUND_WALK = 2048

const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function phaseAggregators(uint16 phaseId) view returns (address)'
])

type RoundData = readonly [bigint, bigint, bigint, bigint, bigint]

function previousRoundId(roundId: bigint): bigint | null {
  const aggregatorRound = roundId & AGGREGATOR_ROUND_MASK
  if (aggregatorRound <= 1n) {
    return null
  }
  return roundId - 1n
}

function encodeRoundId(phase: bigint, aggregatorRound: bigint): bigint {
  return (phase << PHASE_SHIFT) | (aggregatorRound & AGGREGATOR_ROUND_MASK)
}

async function previousPhaseRound(
  client: PublicClient,
  feed: Address,
  currentRoundId: bigint
): Promise<RoundData | null> {
  const phase = currentRoundId >> PHASE_SHIFT
  if (phase <= 1n) {
    return null
  }
  const previousPhase = phase - 1n
  const aggregator = await maybe(() =>
    client.readContract({
      address: feed,
      abi: FEED_ABI,
      functionName: 'phaseAggregators',
      args: [Number(previousPhase)]
    })
  )
  if (!aggregator || aggregator === zeroAddress) {
    return null
  }
  const latest = await maybe(() =>
    client.readContract({
      address: aggregator,
      abi: FEED_ABI,
      functionName: 'latestRoundData'
    })
  )
  if (!latest) {
    return null
  }
  const encoded = encodeRoundId(previousPhase, latest[0])
  return [encoded, latest[1], latest[2], latest[3], encoded]
}

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
    _chainId: number,
    feed: Address,
    timestamp: number
  ): Promise<HistoricalPriceResult | null> {
    const reads = await maybe(() =>
      Promise.all([
        client.readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData' }),
        client.readContract({ address: feed, abi: FEED_ABI, functionName: 'decimals' })
      ])
    )
    if (!reads) {
      return null
    }

    let round: RoundData = reads[0]
    const decimals = reads[1]
    for (let walked = 0; walked < MAX_ROUND_WALK && Number(round[3]) > timestamp; walked += 1) {
      const previous = previousRoundId(round[0])
      if (previous != null) {
        const older = await maybe(() =>
          client.readContract({
            address: feed,
            abi: FEED_ABI,
            functionName: 'getRoundData',
            args: [previous]
          })
        )
        if (!older) {
          return null
        }
        round = older
        continue
      }
      const olderPhase = await previousPhaseRound(client, feed, round[0])
      if (!olderPhase) {
        return null
      }
      round = olderPhase
    }

    const updatedAt = Number(round[3])
    if (updatedAt > timestamp || updatedAt + MAX_STALENESS_SECONDS < timestamp) {
      return null
    }

    const price = Number(round[1]) / 10 ** Number(decimals)
    if (!this.isUsablePrice(price, updatedAt)) {
      return null
    }

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
