import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { CHAINLINK_FEEDS, getChainlinkFeed } from '../../../src/sources/chainlink/feeds'
import { createChainlinkHistoricalSource } from '../../../src/sources/chainlink/historical'
import { fakeClient } from '../onchain/helpers'

const TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const FEED = getChainlinkFeed(1, TOKEN)

if (!FEED) {
  throw new Error('Ethereum WETH feed is not configured')
}

function source(answer: bigint, updatedAt = 1_700_000_000n, decimals = 8) {
  return createChainlinkHistoricalSource({
    clientForChain: () =>
      fakeClient({
        [FEED.address.toLowerCase()]: {
          latestRoundData: [1n, answer, updatedAt, updatedAt, 1n],
          decimals
        }
      })
  })
}

let readBlocks: bigint[] = []

const HISTORICAL_TIMESTAMP = 1_600_000_000
const LATEST_BLOCK = 1_000n
const SECONDS_PER_BLOCK = 12

function historicalClient(reads: Record<string, unknown>) {
  const blockTimestamp = (blockNumber: bigint) =>
    BigInt(HISTORICAL_TIMESTAMP + (Number(blockNumber) - Number(LATEST_BLOCK) / 2) * SECONDS_PER_BLOCK)

  return {
    async getBlockNumber() {
      return LATEST_BLOCK
    },
    async getBlock({ blockNumber }: { blockNumber?: bigint } = {}) {
      const number = blockNumber ?? LATEST_BLOCK
      return { number, timestamp: blockTimestamp(number) }
    },
    async readContract({ address, functionName, blockNumber }: Record<string, unknown>) {
      readBlocks.push(blockNumber as bigint)
      const contract = reads[(address as string).toLowerCase()] as Record<string, unknown> | undefined
      const value = contract?.[functionName as string]
      if (value === undefined) {
        throw Object.assign(new Error(`execution reverted: ${address}.${functionName}`), {
          name: 'ContractFunctionExecutionError'
        })
      }
      return value
    }
  } as unknown as PublicClient
}

describe('ChainlinkHistoricalSource', () => {
  it('returns null for an unknown token', async () => {
    await expect(
      source(1n).getHistoricalPrice(1, '0x1111111111111111111111111111111111111111', 1_700_000_000)
    ).resolves.toBeNull()
  })

  it('returns null for a stale feed', async () => {
    await expect(source(100_000_000n, 1_699_800_000n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
  })

  it('returns null for a non-positive answer', async () => {
    await expect(source(0n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
    await expect(source(-1n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
  })

  it('scales the answer by feed decimals', async () => {
    await expect(source(123_456_789n, 1_700_000_000n, 8).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toEqual({
      price: 1.23456789,
      timestamp: 1_700_000_000,
      symbol: 'ETH',
      confidence: null
    })
  })

  it('reads the feed at the estimated historical block, not latest', async () => {
    readBlocks = []
    const client = historicalClient({
      [FEED.address.toLowerCase()]: {
        latestRoundData: [1n, 200_000_000_000n, BigInt(HISTORICAL_TIMESTAMP), BigInt(HISTORICAL_TIMESTAMP), 1n],
        decimals: 8
      }
    })

    const result = await createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
      1,
      TOKEN,
      HISTORICAL_TIMESTAMP
    )

    expect(result?.price).toBe(2000)
    expect(readBlocks.length).toBeGreaterThan(0)
    expect(new Set(readBlocks)).toEqual(new Set([LATEST_BLOCK / 2n]))
  })

  it('returns null when the feed reverts at that block', async () => {
    readBlocks = []
    const client = historicalClient({})

    await expect(
      createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
        1,
        TOKEN,
        HISTORICAL_TIMESTAMP
      )
    ).resolves.toBeNull()
  })
})

describe('CHAINLINK_FEEDS', () => {
  it('keys every token by its lowercase address', () => {
    for (const feeds of Object.values(CHAINLINK_FEEDS)) {
      for (const token of Object.keys(feeds)) {
        expect(token).toBe(token.toLowerCase())
      }
    }
  })

  it('has no chain configured with an empty feed map', () => {
    for (const feeds of Object.values(CHAINLINK_FEEDS)) {
      expect(Object.keys(feeds).length).toBeGreaterThan(0)
    }
  })
})
