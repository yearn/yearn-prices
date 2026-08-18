import { describe, expect, it, vi } from 'vitest'
import type { DefiLlamaClient } from '../../src/clients/defillama'
import { createMarketPriceResolver } from '../../src/registries/market-price'
import { HistoricalSourceRegistry } from '../../src/registries/historical'
import { createDefiLlamaAliasHistoricalSource } from '../../src/sources/defillama/alias'
import { createOnchainHistoricalSource } from '../../src/sources/onchain'
import { fakeClient } from '../sources/onchain/helpers'

const OPTIMISM_DAI = '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'
const VAULT = '0x5555555555555555555555555555555555555555'
const TIMESTAMP = 1_700_000_000

const reads = {
  [VAULT]: { asset: OPTIMISM_DAI, decimals: 18, convertToAssets: 2n * 10n ** 18n },
  [OPTIMISM_DAI]: { decimals: 18 },
}

function aliasSources() {
  const defiLlama = {
    getHistorical: vi.fn(async () => ({
      coins: {
        'coingecko:dai': { price: 1, timestamp: TIMESTAMP, symbol: 'DAI', confidence: 0.99 },
      },
    })),
  } as unknown as DefiLlamaClient & { getHistorical: ReturnType<typeof vi.fn> }

  return { defiLlama, sources: [createDefiLlamaAliasHistoricalSource(defiLlama)] }
}

describe('the alias source inside the recursive price path', () => {
  it('prices a vault whose underlying only the alias source knows', async () => {
    const { defiLlama, sources } = aliasSources()
    const registry = new HistoricalSourceRegistry(sources)
    const derived = createOnchainHistoricalSource({
      marketPrice: createMarketPriceResolver(
        sources,
        (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
        { requireTimestamp: true },
      ),
      clientForChain: () => fakeClient(reads),
    })

    const price = await derived.getHistoricalPrice(10, VAULT, TIMESTAMP)

    expect(price?.price).toBeCloseTo(2)
    expect(defiLlama.getHistorical).toHaveBeenCalledWith(TIMESTAMP, ['coingecko:dai'], '6h')
  })

  it('does not reach the alias source on a chain it has no aliases for', async () => {
    const { defiLlama, sources } = aliasSources()
    const registry = new HistoricalSourceRegistry(sources)
    const derived = createOnchainHistoricalSource({
      marketPrice: createMarketPriceResolver(
        sources,
        (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
        { requireTimestamp: true },
      ),
      clientForChain: () => fakeClient(reads),
    })

    await expect(derived.getHistoricalPrice(1, VAULT, TIMESTAMP)).resolves.toBeNull()
    expect(defiLlama.getHistorical).not.toHaveBeenCalled()
  })
})
