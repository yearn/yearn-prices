import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefiLlamaClient } from '../../src/clients/defillama'
import { DEFI_LLAMA_CURRENT_BATCH, fetchCurrentPrices } from '../../src/sources/defillama/current'

const WETH = 'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const OTHER = 'ethereum:0x0000000000000000000000000000000000000001'

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DefiLlamaClient.getCurrent', () => {
  it('requests /prices/current with the joined coins', async () => {
    const fetchMock = stubFetch({ coins: {} })

    await new DefiLlamaClient().getCurrent([WETH, OTHER])

    expect(String(fetchMock.mock.calls[0][0] as unknown as string)).toBe(
      `https://coins.llama.fi/prices/current/${WETH},${OTHER}`
    )
  })
})

describe('fetchCurrentPrices', () => {
  const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

  it('maps usable coins, omits unknown or invalid ones, and skips unsupported chains', async () => {
    const fetchMock = stubFetch({
      coins: {
        [WETH]: { price: 2391.41, symbol: 'WETH', timestamp: 1793884206, confidence: 0.99 },
        [OTHER]: { price: 0, symbol: 'X', timestamp: 1793884206 }
      }
    })

    const prices = await fetchCurrentPrices(new DefiLlamaClient(), [
      { chain: 'ethereum', token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
      { chain: 'ethereum', token: '0x0000000000000000000000000000000000000001' },
      { chain: 'robinhood', token: '0x0000000000000000000000000000000000000002' }
    ])

    expect([...prices.keys()]).toEqual([WETH])
    expect(prices.get(WETH)).toEqual({ price: 2391.41, timestamp: 1793884206, symbol: 'WETH', confidence: 0.99 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0] as unknown as string)).not.toContain('robinhood')
  })

  it('dedupes and splits requests into batches', async () => {
    const fetchMock = stubFetch({ coins: {} })
    const targets = Array.from({ length: DEFI_LLAMA_CURRENT_BATCH + 1 }, (_, i) => ({
      chain: 'ethereum',
      token: token(i + 1)
    }))

    await fetchCurrentPrices(new DefiLlamaClient(), [...targets, targets[0]])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
