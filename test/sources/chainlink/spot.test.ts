import type { PublicClient } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getChainlinkFeed } from '../../../src/sources/chainlink/feeds'
import { createChainlinkSpotSource } from '../../../src/sources/chainlink/spot'
import { fakeClient } from '../onchain/helpers'

const TOKEN = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const FEED = getChainlinkFeed(1, TOKEN)

if (!FEED) throw new Error('Ethereum WETH feed is not configured')

afterEach(() => {
  vi.useRealTimers()
})

describe('ChainlinkSpotSource', () => {
  it('reuses the latest Chainlink round and preserves updatedAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_100_000))
    const source = createChainlinkSpotSource({
      clientForChain: () =>
        fakeClient({
          [FEED.toLowerCase()]: {
            latestRoundData: [1n, 2_500_000_000n, 1_700_000_000n, 1_700_000_000n, 1n],
            decimals: 8
          }
        })
    })

    await expect(source.getSpotPrice(1, TOKEN)).resolves.toEqual({
      price: 25,
      timestamp: 1_700_000_000,
      symbol: null,
      confidence: null
    })
  })

  it('does not support feeds when no RPC client is configured', () => {
    expect(createChainlinkSpotSource({ clientForChain: () => null }).supports(1)).toBe(false)
  })

  it('stops the caller at an aborted signal while the viem read continues in the background', async () => {
    const pendingClient = {
      readContract: vi.fn(() => new Promise(() => undefined))
    } as unknown as PublicClient
    const source = createChainlinkSpotSource({ clientForChain: () => pendingClient })
    const controller = new AbortController()
    const pending = source.getSpotPrice(1, TOKEN, controller.signal)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
