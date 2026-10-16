import type { KongVaultListItem } from '../../src/types'
import { chainIdToName, normalizeTokenAddress } from '../../src/utils'

export const KONG_URL = 'https://kong.yearn.fi/api/rest/list/vaults?origin=yearn'

export interface NormalizedVault {
  chain: string
  chainId: number
  vaultToken: `0x${string}`
  underlyingToken: `0x${string}`
  symbol: string | null
  apiVersion: string | null
  decimals: number
  isRetired: boolean
  tvl: number
}

export async function fetchYearnVaults(): Promise<NormalizedVault[]> {
  const response = await fetch(KONG_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new Error(`Failed to fetch Kong vault list: ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new Error('Unexpected Kong vault list payload: expected an array')
  const json = payload as KongVaultListItem[]
  const vaults: NormalizedVault[] = []

  for (const item of json) {
    const chain = item && typeof item.chainId === 'number' ? chainIdToName(item.chainId) : undefined
    if (!chain || !item.address || !item.asset?.address || typeof item.decimals !== 'number') {
      continue
    }

    try {
      vaults.push({
        chain,
        chainId: item.chainId,
        vaultToken: normalizeTokenAddress(item.address),
        underlyingToken: normalizeTokenAddress(item.asset.address),
        symbol: item.symbol,
        apiVersion: item.apiVersion,
        decimals: item.decimals,
        isRetired: item.isRetired === true,
        tvl: item.tvl ?? 0
      })
    } catch (error) {
      console.warn(`skip:kong-vault ${item.chainId}:${item.address}`, error)
    }
  }

  return vaults
}
