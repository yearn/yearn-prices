import { getDefiLlamaCoinGeckoAlias, isDefiLlamaAliasValidAt } from '../sources/defillama/aliases'

export function applicableAlias(target: {
  chain: string
  token: string
  eodTimestamp: number
}): { identifier: string; isEligibleObservation: (observedTimestamp: number) => boolean } | undefined {
  const alias = getDefiLlamaCoinGeckoAlias(target.chain, target.token)
  if (alias == null || !isDefiLlamaAliasValidAt(alias, target.eodTimestamp)) {
    return undefined
  }
  return {
    identifier: alias.identifier,
    isEligibleObservation: (observedTimestamp: number) => isDefiLlamaAliasValidAt(alias, observedTimestamp)
  }
}
