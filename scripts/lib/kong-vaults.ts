import type { KongVaultListItem } from '../../src/types'
import { chainIdToName, normalizeTokenAddress } from '../../src/utils'

export interface NormalizedVault {
  chain: string
  chainId: number
  vaultToken: `0x${string}`
  underlyingToken: `0x${string}`
  symbol: string | null
  apiVersion: string | null
  decimals: number
}

export async function fetchYearnVaults(): Promise<NormalizedVault[]> {
  const response = await fetch('https://kong.yearn.fi/api/rest/list/vaults?origin=yearn')
  if (!response.ok) {
    throw new Error(`Failed to fetch Kong vault list: ${response.status}`)
  }

  const json = (await response.json()) as KongVaultListItem[]
  const vaults: NormalizedVault[] = []

  for (const item of json) {
    const chain = chainIdToName(item.chainId)
    if (!chain || !item.asset?.address || !item.decimals) {
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
        decimals: item.decimals
      })
    } catch {}
  }

  return vaults
}
