import { describe, expect, it, vi } from 'vitest'
import { contractContext, HistoricalBlockCache } from '../../../src/sources/onchain/context'
import { BLOCK_NUMBER, BLOCK_TIMESTAMP, fakeClient } from './helpers'

const TOKEN = '0x1111111111111111111111111111111111111111'

describe('contractContext cache', () => {
  it('loads block context once per target when adapters share a cache', async () => {
    const client = fakeClient({ [TOKEN]: { decimals: 18 } })
    const getBlock = vi.spyOn(client, 'getBlock')
    const options = {
      clientForChain: () => client,
      blockContextCache: new Map()
    }

    await contractContext({ chainId: 1, token: TOKEN, timestamp: null }, options)
    await contractContext({ chainId: 1, token: TOKEN, timestamp: null }, options)

    expect(getBlock).toHaveBeenCalledTimes(1)
  })

  it('does not start the next RPC read when cancellation arrives during block lookup', async () => {
    const controller = new AbortController()
    let finishBlockLookup: (() => void) | undefined
    const client = fakeClient({ [TOKEN]: { decimals: 18 } })
    const getBlockNumber = vi.fn(
      () =>
        new Promise<bigint>((resolve) => {
          finishBlockLookup = () => resolve(BLOCK_NUMBER)
        })
    )
    const getBlock = vi.spyOn(client, 'getBlock')
    Object.assign(client, { getBlockNumber })
    const pending = contractContext(
      { chainId: 1, token: TOKEN, timestamp: null, signal: controller.signal },
      { clientForChain: () => client }
    )

    await vi.waitFor(() => expect(getBlockNumber).toHaveBeenCalledOnce())
    controller.abort()
    finishBlockLookup?.()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(getBlock).not.toHaveBeenCalled()
  })
})

it('coalesces historical block facts across tokens without sharing clients or budgets', async () => {
  const first = fakeClient({})
  const second = fakeClient({})
  const getBlockA = vi.spyOn(first, 'getBlock')
  const getBlockB = vi.spyOn(second, 'getBlock')
  const blockForTarget = vi.fn(async () => BLOCK_NUMBER)
  const historicalBlocks = new HistoricalBlockCache()
  const target = { chainId: 1, token: TOKEN, timestamp: BLOCK_TIMESTAMP + 1 }
  const [a, b] = await Promise.all([
    contractContext(target, { clientForChain: () => first, blockForTarget, historicalBlocks }),
    contractContext(
      { ...target, token: '0x2222222222222222222222222222222222222222' },
      {
        clientForChain: () => second,
        blockForTarget,
        historicalBlocks
      }
    )
  ])
  expect(blockForTarget).toHaveBeenCalledTimes(1)
  expect(getBlockA.mock.calls.length + getBlockB.mock.calls.length).toBe(1)
  expect(a.client).toBe(first)
  expect(b.client).toBe(second)
  expect(a.address).not.toBe(b.address)
  await contractContext(
    { ...target, blockNumber: Number(BLOCK_NUMBER) },
    {
      clientForChain: () => second,
      blockForTarget,
      historicalBlocks
    }
  )
  expect(getBlockA.mock.calls.length + getBlockB.mock.calls.length).toBe(1)
  await contractContext({ ...target, chainId: 10 }, { clientForChain: () => second, blockForTarget, historicalBlocks })
  expect(blockForTarget).toHaveBeenCalledTimes(2)
})

it('retries a failed block lookup even when the per-target context cache is shared', async () => {
  const client = fakeClient({})
  const blockForTarget = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue(BLOCK_NUMBER)
  const options = {
    clientForChain: () => client,
    blockForTarget,
    historicalBlocks: new HistoricalBlockCache(),
    blockContextCache: new Map()
  }
  const target = { chainId: 1, token: TOKEN, timestamp: BLOCK_TIMESTAMP + 1 }
  await expect(contractContext(target, options)).rejects.toThrow('429')
  expect((await contractContext(target, options)).blockNumber).toBe(BLOCK_NUMBER)
  expect(blockForTarget).toHaveBeenCalledTimes(2)
})
