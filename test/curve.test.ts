import { describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import { priceCurveLpUsd } from '../src/clients'

const ZERO = '0x0000000000000000000000000000000000000000'
const REGISTRY = '0x0000000000000000000000000000000000000099'
const POOL = '0x00000000000000000000000000000000000000aa'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const VP_1_01 = 1_010000000000000000n // 1.01 * 1e18

interface MockReads {
  registry?: string
  pool?: string
  virtualPrice?: bigint
  coins?: string[]
}

// Dispatches readContract by functionName so each test controls only what it
// exercises. Defaults form a healthy stableswap pool (registry -> pool -> DAI).
function mockClient(reads: MockReads = {}): PublicClient {
  const {
    registry = REGISTRY,
    pool = POOL,
    virtualPrice = VP_1_01,
    coins = [DAI, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO]
  } = reads
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'get_registry':
          return registry
        case 'get_pool_from_lp_token':
          return pool
        case 'get_virtual_price':
          return virtualPrice
        case 'get_coins':
          return coins
        default:
          throw new Error(`unexpected call: ${functionName}`)
      }
    })
  } as unknown as PublicClient
}

// Module-level registry/pool caches are keyed by chainId, so a distinct chainId
// per test keeps them from bleeding across cases.
describe('priceCurveLpUsd', () => {
  it('prices a stableswap LP as virtual_price/1e18 * price(coin0)', async () => {
    const price = await priceCurveLpUsd(mockClient(), 1, '0x01', 0n, async () => 1)
    expect(price).toBeCloseTo(1.01, 10)
  })

  it('returns null when the chain has no Curve registry', async () => {
    const price = await priceCurveLpUsd(mockClient({ registry: ZERO }), 2, '0x02', 0n, async () => 1)
    expect(price).toBeNull()
  })

  it('returns null when the token is not a registered Curve LP', async () => {
    const price = await priceCurveLpUsd(mockClient({ pool: ZERO }), 3, '0x03', 0n, async () => 1)
    expect(price).toBeNull()
  })

  it('returns null when the pool has no coin0', async () => {
    const coins = Array<string>(8).fill(ZERO)
    const price = await priceCurveLpUsd(mockClient({ coins }), 4, '0x04', 0n, async () => 1)
    expect(price).toBeNull()
  })

  it('returns null when coin0 has no price', async () => {
    const price = await priceCurveLpUsd(mockClient(), 5, '0x05', 0n, async () => null)
    expect(price).toBeNull()
  })

  it('does not cache the registry on a transient get_registry error', async () => {
    const client = mockClient()
    const readContract = client.readContract as ReturnType<typeof vi.fn>
    readContract.mockImplementationOnce(() => {
      throw new Error('RPC timeout')
    })

    // First call: get_registry throws -> null, must NOT poison the cache.
    expect(await priceCurveLpUsd(client, 6, '0x06', 0n, async () => 1)).toBeNull()
    // Second call on the same chain: registry resolves, fallback still works.
    expect(await priceCurveLpUsd(client, 6, '0x06', 0n, async () => 1)).toBeCloseTo(1.01, 10)
  })
})
