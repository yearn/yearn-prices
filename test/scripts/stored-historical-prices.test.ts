import { expect, it, vi } from 'vitest'
import { storedHistoricalPrices } from '../../scripts/lib/stored-historical-prices'

it('shares exact stored prices across block contexts and marks observation provenance unknown', async () => {
  const timestamp = 1704067199
  const token = '0x1111111111111111111111111111111111111111'
  const query = vi.fn(async () => ({
    rows: [
      {
        chain: 'ethereum',
        token,
        timestamp: new Date(timestamp * 1000),
        price: '2',
        symbol: 'T',
        confidence: null,
        source: 'curve'
      }
    ]
  }))
  const prices = storedHistoricalPrices({ query } as never)
  await prices.prefetch([
    { chainId: 1, token, timestamp },
    { chainId: 1, token, timestamp, blockNumber: 100 }
  ])
  expect(query).toHaveBeenCalledTimes(1)
  expect(prices.get({ chainId: 1, token, timestamp, blockNumber: 101 })).toMatchObject({
    priceUsd: 2,
    adapter: 'stored-historical',
    metadata: { providerObservationTimestamp: null, storedTimestamp: timestamp }
  })
  await prices.prefetch([{ chainId: 1, token, timestamp }])
  expect(query).toHaveBeenCalledTimes(1)
})
it('does not turn a database failure into a missing-price cache entry', async () => {
  const prices = storedHistoricalPrices({
    query: async () => {
      throw new Error('unavailable')
    }
  } as never)
  await expect(
    prices.prefetch([{ chainId: 1, token: '0x1111111111111111111111111111111111111111', timestamp: 1704067199 }])
  ).rejects.toThrow('unavailable')
})
