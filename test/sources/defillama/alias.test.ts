import { describe, expect, it, vi } from 'vitest'
import type { DefiLlamaClient } from '../../../src/clients/defillama'
import { ApiError } from '../../../src/http/errors'
import { createDefiLlamaAliasHistoricalSource } from '../../../src/sources/defillama/alias'
import { DEFI_LLAMA_ALIAS_CHAINS } from '../../../src/sources/defillama/aliases'
import { chainIdToName } from '../../../src/utils/chains'

const OPTIMISM_DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const FANTOM_USDC = '0x04068da6c83afcfa0e13ba15a6696662335d5b75'
const UNKNOWN = '0x1111111111111111111111111111111111111111'
const TIMESTAMP = 1_700_000_000
const BEFORE_MULTICHAIN = 1_688_000_000
const AFTER_MULTICHAIN = 1_689_000_000

function client(coins: Record<string, unknown>) {
  return {
    getHistorical: vi.fn(async () => ({ coins })),
  } as unknown as DefiLlamaClient & { getHistorical: ReturnType<typeof vi.fn> }
}

describe('createDefiLlamaAliasHistoricalSource', () => {
  it('supports only chains that have aliases', () => {
    const source = createDefiLlamaAliasHistoricalSource(client({}))

    expect(source.supports(10)).toBe(true)
    expect(source.supports(250)).toBe(true)
    expect(source.supports(1)).toBe(false)
    expect(source.supports(10)).toBe(DEFI_LLAMA_ALIAS_CHAINS.has(chainIdToName(10) ?? ''))
    expect(source.supports(999)).toBe(false)
  })

  it('derives supports() from the alias table, not a hardcoded chain list', () => {
    const source = createDefiLlamaAliasHistoricalSource(client({}))

    for (const [chainId, name] of [
      [10, 'optimism'],
      [250, 'fantom'],
      [1, 'ethereum'],
    ] as const) {
      expect(source.supports(chainId)).toBe(DEFI_LLAMA_ALIAS_CHAINS.has(name))
    }
  })

  it('prices an aliased token through its CoinGecko market', async () => {
    const defiLlama = client({
      'coingecko:dai': { price: 1.001, timestamp: TIMESTAMP, symbol: 'DAI', confidence: 0.99 },
    })
    const source = createDefiLlamaAliasHistoricalSource(defiLlama)

    const price = await source.getHistoricalPrice(10, OPTIMISM_DAI, TIMESTAMP)

    expect(price).toEqual({
      price: 1.001,
      timestamp: TIMESTAMP,
      symbol: 'DAI',
      confidence: 0.99,
    })
    expect(defiLlama.getHistorical).toHaveBeenCalledWith(TIMESTAMP, ['coingecko:dai'], '6h')
  })

  it('returns null for a token with no alias', async () => {
    const source = createDefiLlamaAliasHistoricalSource(client({}))

    await expect(source.getHistoricalPrice(10, UNKNOWN, TIMESTAMP)).resolves.toBeNull()
  })

  it('prices a bridged token before its bridge was impaired', async () => {
    const source = createDefiLlamaAliasHistoricalSource(
      client({
        'coingecko:usd-coin': { price: 1, timestamp: BEFORE_MULTICHAIN, symbol: 'USDC' },
      }),
    )

    const price = await source.getHistoricalPrice(250, FANTOM_USDC, BEFORE_MULTICHAIN)

    expect(price?.price).toBe(1)
  })

  it('refuses a bridged token after its bridge was impaired', async () => {
    const source = createDefiLlamaAliasHistoricalSource(
      client({
        'coingecko:usd-coin': { price: 1, timestamp: AFTER_MULTICHAIN, symbol: 'USDC' },
      }),
    )

    await expect(
      source.getHistoricalPrice(250, FANTOM_USDC, AFTER_MULTICHAIN),
    ).resolves.toBeNull()
  })

  it('rejects an observation outside the search window', async () => {
    const source = createDefiLlamaAliasHistoricalSource(
      client({
        'coingecko:dai': { price: 1, timestamp: TIMESTAMP - 86_400, symbol: 'DAI' },
      }),
    )

    await expect(source.getHistoricalPrice(10, OPTIMISM_DAI, TIMESTAMP)).resolves.toBeNull()
  })

  it('returns null when the provider has no price', async () => {
    const source = createDefiLlamaAliasHistoricalSource(client({}))

    await expect(source.getHistoricalPrice(10, OPTIMISM_DAI, TIMESTAMP)).resolves.toBeNull()
  })

  it('returns null for a non-positive price', async () => {
    const source = createDefiLlamaAliasHistoricalSource(
      client({ 'coingecko:dai': { price: 0, timestamp: TIMESTAMP } }),
    )

    await expect(source.getHistoricalPrice(10, OPTIMISM_DAI, TIMESTAMP)).resolves.toBeNull()
  })

  it('rejects an observation that falls outside the alias window', async () => {
    const validUntil = 1_688_667_035
    const requested = validUntil - 60
    const source = createDefiLlamaAliasHistoricalSource(
      client({
        'coingecko:usd-coin': { price: 1, timestamp: validUntil + 3600, symbol: 'USDC' },
      }),
    )

    await expect(source.getHistoricalPrice(250, FANTOM_USDC, requested)).resolves.toBeNull()
  })

  it('prices when both the request and the observation stay inside the alias window', async () => {
    const validUntil = 1_688_667_035
    const requested = validUntil - 60
    const source = createDefiLlamaAliasHistoricalSource(
      client({
        'coingecko:usd-coin': { price: 1, timestamp: validUntil - 3600, symbol: 'USDC' },
      }),
    )

    const price = await source.getHistoricalPrice(250, FANTOM_USDC, requested)

    expect(price?.price).toBe(1)
    expect(price?.timestamp).toBe(validUntil - 3600)
  })

  it('propagates a transient provider error', async () => {
    const defiLlama = {
      getHistorical: vi.fn(async () => {
        throw new ApiError('INTERNAL_ERROR', 'llama down')
      }),
    } as unknown as DefiLlamaClient

    const source = createDefiLlamaAliasHistoricalSource(defiLlama)

    await expect(source.getHistoricalPrice(10, OPTIMISM_DAI, TIMESTAMP)).rejects.toMatchObject({
      name: 'ApiError',
      code: 'INTERNAL_ERROR',
    })
  })

  it('throws when searchWidth cannot be parsed', () => {
    expect(() => createDefiLlamaAliasHistoricalSource(client({}), 'nope')).toThrow(
      /Invalid DeFiLlama searchWidth/,
    )
  })
})
