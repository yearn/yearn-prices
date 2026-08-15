import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { estimateBlockByTimestamp } from '../../src/clients/rpc'

const GENESIS = 1_600_000_000
const BLOCK_TIME = 12
const LATEST = 1_000n

function timestampOf(block: bigint): number {
  return GENESIS + Number(block) * BLOCK_TIME
}

// One block every BLOCK_TIME seconds, so the right answer for any timestamp is
// known in closed form. Chain ids are unique per test: the block cache and the
// sample memo are module-level state shared across tests.
function fakeChain(): PublicClient {
  return {
    async getBlock(args?: { blockNumber?: bigint }) {
      const number = args?.blockNumber ?? LATEST
      return { number, timestamp: BigInt(timestampOf(number)) }
    },
  } as unknown as PublicClient
}

describe('estimateBlockByTimestamp', () => {
  it('returns the block minted at the exact timestamp', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_001, timestampOf(500n))

    expect(block).toBe(500n)
  })

  it('returns the last block at or before a timestamp between blocks', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_002, timestampOf(500n) + 5)

    expect(block).toBe(500n)
  })

  it('returns the latest block for a future timestamp', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_003, timestampOf(LATEST) + 1)

    expect(block).toBe(LATEST)
  })

  it('answers from warmed samples exactly as a cold search would', async () => {
    const client = fakeChain()
    await estimateBlockByTimestamp(client, 910_004, timestampOf(200n) + 3)
    await estimateBlockByTimestamp(client, 910_004, timestampOf(800n))

    const warm = await estimateBlockByTimestamp(client, 910_004, timestampOf(600n) + 1)
    const cold = await estimateBlockByTimestamp(fakeChain(), 910_005, timestampOf(600n) + 1)

    expect(warm).toBe(600n)
    expect(warm).toBe(cold)
  })

  it('serves a repeated timestamp from the block cache without new reads', async () => {
    let reads = 0
    const client = {
      async getBlock(args?: { blockNumber?: bigint }) {
        reads += 1
        const number = args?.blockNumber ?? LATEST
        return { number, timestamp: BigInt(timestampOf(number)) }
      },
    } as unknown as PublicClient

    const first = await estimateBlockByTimestamp(client, 910_006, timestampOf(300n) + 1)
    const readsAfterFirst = reads
    const second = await estimateBlockByTimestamp(client, 910_006, timestampOf(300n) + 1)

    expect(second).toBe(first)
    expect(reads).toBe(readsAfterFirst)
  })
})
