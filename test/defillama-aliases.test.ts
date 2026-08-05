import { describe, expect, test } from 'vitest'
import {
  getDefiLlamaCoinGeckoAlias,
  isDefiLlamaAliasValidAt,
  listDefiLlamaCoinGeckoAliases,
} from '../src/defillama-aliases'

const OPTIMISM_DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const OPTIMISM_MAI = '0xdFA46478F9e5EA86d57387849598dbFB2e964b02'
const OPTIMISM_MIM = '0xb153fb3d196a8eb25522705560ac152eeec57901'
const FANTOM_USDC = '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75'
const FANTOM_MIM = '0x82f0b8b456c1a451378467398982d4834b6829c1'
const FANTOM_GLOBAL_BOUNDARY = 1_688_667_035

describe('DefiLlama CoinGecko aliases', () => {
  test('normalizes chain names and token addresses for lookup', () => {
    expect(getDefiLlamaCoinGeckoAlias('OPTIMISM', OPTIMISM_DAI.toLowerCase())).toMatchObject({
      chain: 'optimism',
      identifier: 'coingecko:dai',
    })
  })

  test('does not implicitly map Optimism MAI to mimatic', () => {
    expect(getDefiLlamaCoinGeckoAlias('optimism', OPTIMISM_MAI)).toBeNull()
    expect(listDefiLlamaCoinGeckoAliases().some(alias => alias.identifier.includes('mimatic'))).toBe(false)
  })

  test('maps the reviewed Optimism MIM contract to its chain-specific market', () => {
    expect(getDefiLlamaCoinGeckoAlias('optimism', OPTIMISM_MIM)).toMatchObject({
      identifier: 'coingecko:magic-internet-money-optimism',
      bridgeIssuer: 'Abracadabra omnichain MIM',
      references: expect.arrayContaining([
        expect.stringContaining('abracadabra.money'),
        expect.stringContaining('coingecko.com'),
      ]),
    })
  })

  test('contains the reviewed Optimism aliases and Fantom time-bounded proxies', () => {
    expect(listDefiLlamaCoinGeckoAliases()).toHaveLength(12)
    expect(new Set(listDefiLlamaCoinGeckoAliases().map(alias => alias.chain)))
      .toEqual(new Set(['optimism', 'fantom']))
  })

  test('treats the Fantom impairment boundary as an exclusive upper bound', () => {
    const proxy = getDefiLlamaCoinGeckoAlias('FANTOM', `0x${FANTOM_USDC.slice(2).toUpperCase()}`)
    expect(proxy).toMatchObject({
      kind: 'canonical-market-proxy',
      identifier: 'coingecko:usd-coin',
      validUntil: FANTOM_GLOBAL_BOUNDARY,
      incident: { ethereumBlock: 17_636_491 },
    })
    expect(isDefiLlamaAliasValidAt(proxy!, FANTOM_GLOBAL_BOUNDARY - 1)).toBe(true)
    expect(isDefiLlamaAliasValidAt(proxy!, FANTOM_GLOBAL_BOUNDARY)).toBe(false)
  })

  test('records MIM as an Abracadabra asset with a conservative global cutoff', () => {
    expect(getDefiLlamaCoinGeckoAlias('fantom', FANTOM_MIM)).toMatchObject({
      identifier: 'coingecko:magic-internet-money',
      bridgeIssuer: 'Abracadabra, bridged by Anyswap/Multichain',
      validUntil: FANTOM_GLOBAL_BOUNDARY,
      incident: { boundary: expect.stringContaining('Conservative global cutoff') },
    })
  })
})
