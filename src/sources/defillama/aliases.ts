import { normalizeTokenAddress } from '../../utils/chains'

export interface DefiLlamaCoinGeckoAlias {
  chain: string
  token: `0x${string}`
  identifier: `coingecko:${string}`
  kind: 'coingecko-alias' | 'canonical-market-proxy'
  bridgeIssuer?: string
  validFrom?: number
  /** Exclusive upper bound: the proxy is not eligible at this timestamp. */
  validUntil?: number
  incident?: {
    id: string
    boundary: string
    ethereumBlock: number
    transactionHash: `0x${string}`
  }
  assumption?: string
  rationale?: string
  references?: readonly string[]
}

const MULTICHAIN_INCIDENT_REFERENCE =
  'https://blog.fantom.foundation/fantom-foundation-awarded-default-judgement-against-multichain/'
const MULTICHAIN_FANTOM_BRIDGE_REFERENCE = 'https://etherscan.io/address/0xc564ee9f21ed8a2d8e7e76c085740d5e4c5fafbe'
const OPTIMISM_TOKEN_LIST_REFERENCE =
  'https://github.com/ethereum-optimism/ethereum-optimism.github.io/blob/master/optimism.tokenlist.json'
const ABRACADABRA_OMNICHAIN_MIM_REFERENCE = 'https://dev.abracadabra.money/token-related/omnichain-mim'
const COINGECKO_OPTIMISM_MIM_REFERENCE =
  'https://api.coingecko.com/api/v3/coins/optimistic-ethereum/contract/0xb153fb3d196a8eb25522705560ac152eeec57901'

function optimismAlias(
  input: Pick<DefiLlamaCoinGeckoAlias, 'token' | 'identifier' | 'rationale'>
): DefiLlamaCoinGeckoAlias {
  return {
    chain: 'optimism',
    kind: 'coingecko-alias',
    assumption: 'provider-identifier-alias-after-direct-market-miss',
    references: [OPTIMISM_TOKEN_LIST_REFERENCE],
    ...input
  }
}

function fantomProxy(
  input: Omit<DefiLlamaCoinGeckoAlias, 'chain' | 'kind' | 'assumption' | 'references'> & {
    references?: readonly string[]
  }
): DefiLlamaCoinGeckoAlias {
  return {
    chain: 'fantom',
    kind: 'canonical-market-proxy',
    assumption: 'pre-multichain-impairment-canonical-market-proxy',
    ...input,
    references: [MULTICHAIN_INCIDENT_REFERENCE, MULTICHAIN_FANTOM_BRIDGE_REFERENCE, ...(input.references ?? [])]
  }
}

const ALIASES: readonly DefiLlamaCoinGeckoAlias[] = [
  optimismAlias({
    token: normalizeTokenAddress('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'),
    identifier: 'coingecko:dai',
    rationale:
      'The requested Optimism DAI contract represents DAI; use its CoinGecko market only after a direct contract lookup misses.'
  }),
  optimismAlias({
    token: normalizeTokenAddress('0x4200000000000000000000000000000000000006'),
    identifier: 'coingecko:weth',
    rationale:
      'The requested Optimism predeploy is WETH; use the WETH CoinGecko market only after a direct contract lookup misses.'
  }),
  optimismAlias({
    token: normalizeTokenAddress('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'),
    identifier: 'coingecko:tether',
    rationale:
      'The requested Optimism contract represents bridged USDT; use the Tether CoinGecko market only after a direct contract lookup misses.'
  }),
  optimismAlias({
    token: normalizeTokenAddress('0x7F5c764cBc14f9669B88837ca1490cCa17c31607'),
    identifier: 'coingecko:usd-coin',
    rationale:
      'The requested Optimism contract represents bridged USDC.e; use the USDC CoinGecko market only after a direct contract lookup misses.'
  }),
  optimismAlias({
    token: normalizeTokenAddress('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    identifier: 'coingecko:usd-coin',
    rationale:
      'The requested Optimism contract is native USDC; use the USDC CoinGecko market only after a direct contract lookup misses.'
  }),
  {
    chain: 'optimism',
    token: normalizeTokenAddress('0xb153fb3d196a8eb25522705560ac152eeec57901'),
    identifier: 'coingecko:magic-internet-money-optimism',
    kind: 'coingecko-alias',
    bridgeIssuer: 'Abracadabra omnichain MIM',
    assumption: 'provider-identifier-alias-after-direct-market-miss',
    rationale:
      'Abracadabra identifies the requested Optimism contract as omnichain MIM, and CoinGecko maps that exact chain and contract to its Optimism MIM market.',
    references: [OPTIMISM_TOKEN_LIST_REFERENCE, ABRACADABRA_OMNICHAIN_MIM_REFERENCE, COINGECKO_OPTIMISM_MIM_REFERENCE]
  },
  fantomProxy({
    token: normalizeTokenAddress('0x04068da6c83afcfa0e13ba15a6696662335d5b75'),
    identifier: 'coingecko:usd-coin',
    bridgeIssuer: 'Multichain (formerly Anyswap)',
    validUntil: 1_688_667_035,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'First confirmed abnormal Fantom bridge USDC reserve outflow',
      ethereumBlock: 17_636_491,
      transactionHash: '0xbd29fe07555c28527fb0207aa0ac2b67d4afef0426793c35b76d005613477fc4'
    },
    rationale: 'Fantom USDC was a Multichain receipt for canonical USDC reserves before the reserve outflow.'
  }),
  fantomProxy({
    token: normalizeTokenAddress('0x8d11ec38a3eb5e956b052f67da8bdc9bef8abf3e'),
    identifier: 'coingecko:dai',
    bridgeIssuer: 'Multichain (formerly Anyswap)',
    validUntil: 1_688_670_167,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'Confirmed Fantom bridge DAI reserve outflow',
      ethereumBlock: 17_636_750,
      transactionHash: '0x2dc69aa95e60b9b649e31664663837aae4a3246b75b78cc4a2cba10312459c2d'
    },
    rationale: 'Fantom DAI was a Multichain receipt for canonical DAI reserves before the reserve outflow.'
  }),
  fantomProxy({
    token: normalizeTokenAddress('0x049d68029688eabf473097a2fc38ef61633a3c7a'),
    identifier: 'coingecko:tether',
    bridgeIssuer: 'Multichain (formerly Anyswap)',
    validUntil: 1_688_671_067,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'Confirmed Fantom bridge USDT reserve outflow',
      ethereumBlock: 17_636_825,
      transactionHash: '0x6eab00d931a89c8efc7d649b26a4f335c0278f8ee94a712e6abce79acf9fdce4'
    },
    rationale: 'Fantom fUSDT was a Multichain receipt for canonical USDT reserves before the reserve outflow.'
  }),
  fantomProxy({
    token: normalizeTokenAddress('0x82f0b8b456c1a451378467398982d4834b6829c1'),
    identifier: 'coingecko:magic-internet-money',
    bridgeIssuer: 'Abracadabra, bridged by Anyswap/Multichain',
    validUntil: 1_688_667_035,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'Conservative global cutoff at first confirmed Fantom bridge reserve outflow',
      ethereumBlock: 17_636_491,
      transactionHash: '0xbd29fe07555c28527fb0207aa0ac2b67d4afef0426793c35b76d005613477fc4'
    },
    rationale:
      'Abracadabra documented Fantom MIM as issuer-backed MIM bridged by Anyswap; no asset-specific July 6 reserve outflow was established.',
    references: [
      'https://docs.abracadabra.money/learn/tokens/tokenomics',
      'https://dev.abracadabra.money/token-related/omnichain-mim'
    ]
  }),
  fantomProxy({
    token: normalizeTokenAddress('0x321162cd933e2be498cd2267a90534a804051b11'),
    identifier: 'coingecko:wrapped-bitcoin',
    bridgeIssuer: 'Multichain (formerly Anyswap)',
    validUntil: 1_688_668_391,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'Confirmed Fantom bridge WBTC reserve outflow',
      ethereumBlock: 17_636_602,
      transactionHash: '0x448f2a6a6c071cdce254937e06305a033538e1aeb9339227d0e59e0458e6185c'
    },
    rationale: 'Fantom BTC was a Multichain receipt for canonical WBTC reserves before the reserve outflow.'
  }),
  fantomProxy({
    token: normalizeTokenAddress('0x74b23882a30290451a17c44f4f05243b6b58c76d'),
    identifier: 'coingecko:weth',
    bridgeIssuer: 'Multichain (formerly Anyswap)',
    validUntil: 1_688_668_871,
    incident: {
      id: 'multichain-fantom-2023-07',
      boundary: 'Confirmed Fantom bridge WETH reserve outflow',
      ethereumBlock: 17_636_642,
      transactionHash: '0xda80a8c8d5a8fdf0208a6fd01c39af018e400763b1d08f3543f52353345fe62e'
    },
    rationale: 'Fantom ETH was a Multichain receipt for canonical WETH reserves before the reserve outflow.'
  })
]

function aliasKey(chain: string, token: string): string {
  return `${chain.toLowerCase()}:${normalizeTokenAddress(token).toLowerCase()}`
}

const ALIAS_BY_TOKEN = new Map(ALIASES.map((alias) => [aliasKey(alias.chain, alias.token), alias] as const))

export function getDefiLlamaCoinGeckoAlias(chain: string, token: string): DefiLlamaCoinGeckoAlias | null {
  return ALIAS_BY_TOKEN.get(aliasKey(chain, token)) ?? null
}

export function listDefiLlamaCoinGeckoAliases(): readonly DefiLlamaCoinGeckoAlias[] {
  return ALIASES
}

export const DEFI_LLAMA_ALIAS_CHAINS: ReadonlySet<string> = new Set(ALIASES.map((alias) => alias.chain))

export function isDefiLlamaAliasValidAt(alias: DefiLlamaCoinGeckoAlias, timestamp: number): boolean {
  return (
    (alias.validFrom == null || timestamp >= alias.validFrom) &&
    (alias.validUntil == null || timestamp < alias.validUntil)
  )
}
