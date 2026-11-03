import { describe, expect, it, vi } from 'vitest'
import { contractContext } from '../../../src/sources/onchain/context'
import { BLOCK_NUMBER, fakeClient } from './helpers'

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
