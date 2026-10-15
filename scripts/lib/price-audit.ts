import type { PriceSource } from '../../src/types'
import type { NormalizedVault } from './kong-vaults'

export type AuditKind = 'underlying' | 'vault'

export const ACCEPTED_SOURCES: Record<AuditKind, PriceSource[]> = {
  underlying: ['defillama', 'defillama-alias', 'chainlink', 'on-chain-oracle', 'bobs-api', 'curve', 'derived', 'enso'],
  vault: ['derived', 'defillama', 'defillama-alias']
}

export const AUDIT_SOURCES: PriceSource[] = [...new Set(Object.values(ACCEPTED_SOURCES).flat())]

export interface ExpectedTuple {
  chain: string
  token: string
  timestamp: number
  kind: AuditKind
}

export interface CoverageReport {
  expected: number
  present: number
  missing: ExpectedTuple[]
  missingByChain: Record<string, number>
  missingByKind: Record<AuditKind, number>
}

export function expectedTuples(vaults: NormalizedVault[], timestamps: number[]): ExpectedTuple[] {
  const tokens = new Map<string, { chain: string; token: string; kind: AuditKind }>()
  for (const vault of vaults) {
    tokens.set(`${vault.chain}:${vault.vaultToken}`, { chain: vault.chain, token: vault.vaultToken, kind: 'vault' })
  }
  for (const vault of vaults) {
    tokens.set(`${vault.chain}:${vault.underlyingToken}`, {
      chain: vault.chain,
      token: vault.underlyingToken,
      kind: 'underlying'
    })
  }
  return [...tokens.values()].flatMap((token) => timestamps.map((timestamp) => ({ ...token, timestamp })))
}

export function auditCoverage(
  expected: ExpectedTuple[],
  existing: Partial<Record<PriceSource, Set<string>>>
): CoverageReport {
  const missing = expected.filter((tuple) => {
    const key = `${tuple.chain}:${tuple.token}:${tuple.timestamp}`
    return !ACCEPTED_SOURCES[tuple.kind].some((source) => existing[source]?.has(key))
  })
  const missingByChain: Record<string, number> = {}
  const missingByKind: Record<AuditKind, number> = { underlying: 0, vault: 0 }
  for (const tuple of missing) {
    missingByChain[tuple.chain] = (missingByChain[tuple.chain] ?? 0) + 1
    missingByKind[tuple.kind] += 1
  }
  return {
    expected: expected.length,
    present: expected.length - missing.length,
    missing,
    missingByChain,
    missingByKind
  }
}
