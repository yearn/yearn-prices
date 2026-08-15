import { describe, expect, it, vi } from 'vitest'
import { contractContext } from '../../../src/sources/onchain/context'
import { fakeClient } from './helpers'

const TOKEN = '0x1111111111111111111111111111111111111111'

describe('contractContext cache', () => {
  it('loads block context once per target when adapters share a cache', async () => {
    const client = fakeClient({ [TOKEN]: { decimals: 18 } })
    const getBlock = vi.spyOn(client, 'getBlock')
    const options = {
      clientForChain: () => client,
      blockContextCache: new Map(),
    }

    await contractContext({ chainId: 1, token: TOKEN, timestamp: null }, options)
    await contractContext({ chainId: 1, token: TOKEN, timestamp: null }, options)

    expect(getBlock).toHaveBeenCalledTimes(1)
  })
})
