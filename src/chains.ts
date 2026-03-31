import type { ParsedTokenKey } from './types'

export const CHAIN_ID_TO_NAME = {
  1: 'ethereum',
  10: 'optimism',
  100: 'gnosis',
  137: 'polygon',
  146: 'sonic',
  250: 'fantom',
  8453: 'base',
  42161: 'arbitrum',
  80094: 'berachain',
  747474: 'katana',
} as const

export const SUPPORTED_CHAIN_NAMES: ReadonlySet<string> = new Set(Object.values(CHAIN_ID_TO_NAME))

const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

export function chainIdToName(chainId: number): string | undefined {
  return CHAIN_ID_TO_NAME[chainId as keyof typeof CHAIN_ID_TO_NAME]
}

export function normalizeTokenAddress(token: string): `0x${string}` {
  if (!TOKEN_ADDRESS_PATTERN.test(token)) {
    throw new Error(`Unsupported token address: ${token}`)
  }

  return token.toLowerCase() as `0x${string}`
}

export function parseTokenKey(tokenKey: string): ParsedTokenKey {
  const separatorIndex = tokenKey.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === tokenKey.length - 1) {
    throw new Error(`Invalid token key: ${tokenKey}`)
  }

  const chain = tokenKey.slice(0, separatorIndex).toLowerCase()
  const token = normalizeTokenAddress(tokenKey.slice(separatorIndex + 1))
  if (!SUPPORTED_CHAIN_NAMES.has(chain)) {
    throw new Error(`Unsupported chain: ${chain}`)
  }

  return { chain, token, tokenKey: `${chain}:${token}` }
}

export function normalizeTokenKey(chain: string, token: string): string {
  return `${chain.toLowerCase()}:${normalizeTokenAddress(token)}`
}
