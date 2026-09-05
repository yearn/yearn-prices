import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../src/http/errors'
import { CHAINLINK_FEEDS, getChainlinkFeed } from '../../../src/sources/chainlink/feeds'
import { createChainlinkHistoricalSource } from '../../../src/sources/chainlink/historical'
import { fakeClient } from '../onchain/helpers'

const TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const ARBITRUM_USDC_TOKEN = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const FEED = getChainlinkFeed(1, TOKEN)

if (!FEED) {
  throw new Error('Ethereum WETH feed is not configured')
}

function source(answer: bigint, updatedAt = 1_700_000_000n, decimals: number | bigint = 8n) {
  return createChainlinkHistoricalSource({
    clientForChain: () =>
      fakeClient({
        [FEED.toLowerCase()]: {
          latestRoundData: [1n, answer, updatedAt, updatedAt, 1n],
          decimals
        }
      })
  })
}

let readBlocks: bigint[] = []

const RPC_URL = 'https://rpc.example/v2/secret-key'
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
    async readContract({ address, functionName, blockNumber, args }: Record<string, unknown>) {
      readBlocks.push(blockNumber as bigint)
      const contract = reads[(address as string).toLowerCase()] as Record<string, unknown> | undefined
      if (functionName === 'getRoundData') {
        const rounds = contract?.getRoundData as Record<string, unknown> | undefined
        const value = rounds?.[String((args as bigint[])[0])]
        if (value === undefined) {
          throw Object.assign(new Error(`execution reverted: ${address}.${functionName}`), {
            name: 'ContractFunctionExecutionError'
          })
        }
        return value
      }
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

  it('prices a round aged past one heartbeat but inside the staleness bound', async () => {
    await expect(source(100_000_000n, 1_699_900_000n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toEqual({
      price: 1,
      timestamp: 1_699_900_000,
      symbol: null,
      confidence: null
    })
  })

  it('returns null for a non-positive answer', async () => {
    await expect(source(0n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
    await expect(source(-1n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toBeNull()
  })

  it('supports a chain with feeds and a client', () => {
    expect(source(1n).supports(1)).toBe(true)
  })

  it('does not support a chain without feeds', () => {
    expect(source(1n).supports(999_999)).toBe(false)
  })

  it('does not support a chain without an rpc client', () => {
    expect(createChainlinkHistoricalSource({ clientForChain: () => null }).supports(1)).toBe(false)
  })

  it('scales the answer by feed decimals', async () => {
    await expect(source(123_456_789n, 1_700_000_000n, 8).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toEqual({
      price: 1.23456789,
      timestamp: 1_700_000_000,
      symbol: null,
      confidence: null
    })
  })

  it('reads latestRoundData at head when that round is already at or before the request', async () => {
    readBlocks = []
    const client = historicalClient({
      [FEED.toLowerCase()]: {
        latestRoundData: [
          5n,
          200_000_000_000n,
          BigInt(HISTORICAL_TIMESTAMP - 100),
          BigInt(HISTORICAL_TIMESTAMP - 100),
          5n
        ],
        decimals: 8
      }
    })
    client.getBlock = async () => {
      throw new Error('historical eth_call is unavailable; do not search blocks')
    }

    const result = await createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
      1,
      TOKEN,
      HISTORICAL_TIMESTAMP
    )

    expect(result?.price).toBe(2000)
    expect(new Set(readBlocks)).toEqual(new Set([undefined]))
  })

  it('walks getRoundData backward when latest is newer than the request', async () => {
    readBlocks = []
    const client = historicalClient({
      [FEED.toLowerCase()]: {
        latestRoundData: [5n, 250_000_000_000n, 1_600_000_500n, 1_600_000_500n, 5n],
        getRoundData: {
          '4': [4n, 150_000_000_000n, 1_599_999_000n, 1_599_999_000n, 4n]
        },
        decimals: 8
      }
    })
    client.getBlock = async () => {
      throw new Error('historical eth_call is unavailable; do not search blocks')
    }

    const result = await createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
      1,
      TOKEN,
      HISTORICAL_TIMESTAMP
    )

    expect(result).toEqual({
      price: 1500,
      timestamp: 1_599_999_000,
      symbol: null,
      confidence: null
    })
    expect(new Set(readBlocks)).toEqual(new Set([undefined]))
  })

  it('rejects when the read fails on transport, instead of reading as no price', async () => {
    const client = {
      async getBlockNumber() {
        return LATEST_BLOCK
      },
      async getBlock() {
        return { number: LATEST_BLOCK, timestamp: BigInt(HISTORICAL_TIMESTAMP) }
      },
      async readContract() {
        throw Object.assign(new Error('HTTP request failed'), { name: 'HttpRequestError' })
      }
    } as unknown as PublicClient

    await expect(
      createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
        1,
        TOKEN,
        HISTORICAL_TIMESTAMP
      )
    ).rejects.toThrow(ApiError)
  })

  it('scales a bigint decimals value into a concrete price', async () => {
    await expect(source(123_456_789n, 1_700_000_000n, 8n).getHistoricalPrice(1, TOKEN, 1_700_000_000)).resolves.toEqual(
      {
        price: 1.23456789,
        timestamp: 1_700_000_000,
        symbol: null,
        confidence: null
      }
    )
  })

  it('still prices when historical block lookup is unavailable', async () => {
    const client = {
      async getBlockNumber() {
        return LATEST_BLOCK
      },
      async getBlock() {
        throw Object.assign(new Error(`HTTP request failed. URL: ${RPC_URL}`), { name: 'HttpRequestError' })
      },
      async readContract({ functionName }: { functionName: string }) {
        if (functionName === 'decimals') return 8
        if (functionName === 'latestRoundData') {
          return [1n, 100_000_000n, BigInt(HISTORICAL_TIMESTAMP), BigInt(HISTORICAL_TIMESTAMP), 1n]
        }
        throw Object.assign(new Error(`execution reverted: ${functionName}`), {
          name: 'ContractFunctionExecutionError'
        })
      }
    } as unknown as PublicClient

    await expect(
      createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
        1,
        TOKEN,
        HISTORICAL_TIMESTAMP
      )
    ).resolves.toEqual({
      price: 1,
      timestamp: HISTORICAL_TIMESTAMP,
      symbol: null,
      confidence: null
    })
  })

  it('prices a non-mainnet chain end to end', async () => {
    const arbFeed = getChainlinkFeed(42161, ARBITRUM_USDC_TOKEN)
    if (!arbFeed) {
      throw new Error('Arbitrum USDC feed is not configured')
    }

    readBlocks = []
    const client = historicalClient({
      [arbFeed.toLowerCase()]: {
        latestRoundData: [1n, 100_010_000n, BigInt(HISTORICAL_TIMESTAMP), BigInt(HISTORICAL_TIMESTAMP), 1n],
        decimals: 8
      }
    })

    const chainIds: number[] = []
    const result = await createChainlinkHistoricalSource({
      clientForChain: (chainId) => {
        chainIds.push(chainId)
        return client
      }
    }).getHistoricalPrice(42161, ARBITRUM_USDC_TOKEN, HISTORICAL_TIMESTAMP)

    expect(chainIds).toContain(42161)
    expect(result).toEqual({
      price: 1.0001,
      timestamp: HISTORICAL_TIMESTAMP,
      symbol: null,
      confidence: null
    })
    expect(new Set(readBlocks)).toEqual(new Set([undefined]))
  })

  it('does not name the feed asset when the token symbol differs', async () => {
    const polygonWpol = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270'
    const wpolFeed = getChainlinkFeed(137, polygonWpol)
    if (!wpolFeed) {
      throw new Error('Polygon WPOL feed is not configured')
    }

    const client = historicalClient({
      [wpolFeed.toLowerCase()]: {
        latestRoundData: [1n, 50_000_000n, BigInt(HISTORICAL_TIMESTAMP), BigInt(HISTORICAL_TIMESTAMP), 1n],
        decimals: 8
      }
    })

    const result = await createChainlinkHistoricalSource({ clientForChain: () => client }).getHistoricalPrice(
      137,
      polygonWpol,
      HISTORICAL_TIMESTAMP
    )

    expect(result).toEqual({ price: 0.5, timestamp: HISTORICAL_TIMESTAMP, symbol: null, confidence: null })
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

  it('resolves the robinhood WETH feed to the ETH/USD proxy', () => {
    expect(getChainlinkFeed(4663, '0x0bd7d308f8e1639fab988df18a8011f41eacad73')).toBe(
      '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9'
    )
  })
})
