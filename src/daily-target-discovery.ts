import { chainIdToName, normalizeTokenAddress } from './chains'
import type { DailyPriceTargetInput } from './daily-prices'
import type { KongVaultListItem } from './types'

export const YEARN_VAULT_INVENTORY_URL = 'https://kong.yearn.fi/api/rest/list/vaults?origin=yearn'

export interface DailyTargetDiscoveryDependencies {
  request?: typeof fetch
}

interface DiscoveredTarget {
  chain: string
  token: string
  roles: Set<'underlying' | 'vault-share'>
}

export async function discoverYearnDailyTargets(
  eodTimestamp: number,
  dependencies: DailyTargetDiscoveryDependencies = {},
): Promise<DailyPriceTargetInput[]> {
  const response = await (dependencies.request ?? fetch)(YEARN_VAULT_INVENTORY_URL)
  if (!response.ok) throw new Error(`Yearn vault inventory request failed with HTTP ${response.status}`)
  const inventory = await response.json() as KongVaultListItem[]
  if (!Array.isArray(inventory)) throw new Error('Yearn vault inventory response must be an array')

  const discovered = new Map<string, DiscoveredTarget>()
  const add = (chain: string, token: string, role: DiscoveredTarget['roles'] extends Set<infer T> ? T : never) => {
    const normalized = normalizeTokenAddress(token)
    const key = `${chain}:${normalized.toLowerCase()}`
    const existing = discovered.get(key) ?? { chain, token: normalized, roles: new Set() }
    existing.roles.add(role)
    discovered.set(key, existing)
  }

  for (const vault of inventory) {
    const chain = chainIdToName(vault.chainId)
    if (!chain) continue
    try {
      add(chain, vault.address, 'vault-share')
      if (vault.asset?.address) add(chain, vault.asset.address, 'underlying')
    } catch {
      // A malformed Kong record is excluded rather than poisoning the complete inventory request.
    }
  }

  if (discovered.size === 0) throw new Error('Yearn vault inventory did not yield any supported assets')
  return [...discovered.values()]
    .sort((left, right) => left.chain.localeCompare(right.chain) || left.token.localeCompare(right.token))
    .map(target => ({
      chain: target.chain,
      token: target.token,
      eodTimestamp,
      metadata: {
        origin: 'kong-vault-inventory',
        discoverySource: YEARN_VAULT_INVENTORY_URL,
        roles: [...target.roles].sort(),
      },
    }))
}
