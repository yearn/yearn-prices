import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { estimateBlockByTimestamp } from '../src/clients/rpc'

const GENESIS_TS = 1_600_000_000
const BLOCK_SECONDS = 12
const HEAD = 2_000_000n

function uniformChainClient() {
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint }) => {
    const number = args?.blockNumber ?? HEAD
    return { number, timestamp: BigInt(GENESIS_TS + Number(number) * BLOCK_SECONDS) }
  })
  return { client: { getBlock } as unknown as PublicClient, getBlock }
}

let nextChainId = 900_000

describe('estimateBlockByTimestamp', () => {
  it('finds the block for a mid-chain timestamp', async () => {
    const { client } = uniformChainClient()
    const target = 777_777n
    const timestamp = GENESIS_TS + Number(target) * BLOCK_SECONDS

    const block = await estimateBlockByTimestamp(client, nextChainId++, timestamp)

    expect(block).toBe(target)
  })

  it('finds the last block at or before an inter-block timestamp', async () => {
    const { client } = uniformChainClient()
    const target = 123_456n
    const timestamp = GENESIS_TS + Number(target) * BLOCK_SECONDS + 5

    const block = await estimateBlockByTimestamp(client, nextChainId++, timestamp)

    expect(block).toBe(target)
  })

  it('converges within a handful of probes on a uniform chain', async () => {
    const { client, getBlock } = uniformChainClient()
    const timestamp = GENESIS_TS + 777_777 * BLOCK_SECONDS

    await estimateBlockByTimestamp(client, nextChainId++, timestamp)

    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(7)
  })

  it('coalesces concurrent searches for the same chain and timestamp', async () => {
    const { client, getBlock } = uniformChainClient()
    const timestamp = GENESIS_TS + 777_777 * BLOCK_SECONDS
    const chainId = nextChainId++

    const blocks = await Promise.all(
      Array.from({ length: 10 }, () => estimateBlockByTimestamp(client, chainId, timestamp))
    )

    expect(new Set(blocks)).toEqual(new Set([777_777n]))
    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(7)
  })

  it('does not coalesce across clients: each client runs its own search', async () => {
    const first = uniformChainClient()
    const second = uniformChainClient()
    const timestamp = GENESIS_TS + 777_777 * BLOCK_SECONDS
    const chainId = nextChainId++

    const blocks = await Promise.all([
      estimateBlockByTimestamp(first.client, chainId, timestamp),
      estimateBlockByTimestamp(second.client, chainId, timestamp)
    ])

    expect(blocks).toEqual([777_777n, 777_777n])
    expect(first.getBlock.mock.calls.length).toBeGreaterThan(0)
    expect(second.getBlock.mock.calls.length).toBeGreaterThan(0)
  })

  it('does not fail one client with another client failing search', async () => {
    const failing = vi.fn(async () => {
      throw new Error('read budget exhausted')
    })
    const brokenClient = { getBlock: failing } as unknown as PublicClient
    const healthy = uniformChainClient()
    const timestamp = GENESIS_TS + 777_777 * BLOCK_SECONDS
    const chainId = nextChainId++

    const [broken, ok] = await Promise.allSettled([
      estimateBlockByTimestamp(brokenClient, chainId, timestamp),
      estimateBlockByTimestamp(healthy.client, chainId, timestamp)
    ])

    expect(broken.status).toBe('rejected')
    expect(ok).toEqual({ status: 'fulfilled', value: 777_777n })
  })

  it('returns the head block for a timestamp at or past the head', async () => {
    const { client, getBlock } = uniformChainClient()
    const timestamp = GENESIS_TS + Number(HEAD) * BLOCK_SECONDS + 999

    const block = await estimateBlockByTimestamp(client, nextChainId++, timestamp)

    expect(block).toBe(HEAD)
    expect(getBlock).toHaveBeenCalledTimes(1)
  })

  it('returns genesis for a timestamp before the chain existed', async () => {
    const { client } = uniformChainClient()

    const block = await estimateBlockByTimestamp(client, nextChainId++, GENESIS_TS - 999)

    expect(block).toBe(0n)
  })
})
