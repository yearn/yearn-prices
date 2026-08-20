import { describe, expect, it } from 'vitest'
import { getChainlinkFeed } from '../../../src/sources/chainlink/feeds'
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
})
