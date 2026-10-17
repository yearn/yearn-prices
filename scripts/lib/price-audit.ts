import type { PriceSource } from '../../src/types'
import type { NormalizedVault } from './kong-vaults'

export type AuditKind = 'underlying' | 'vault'
export const AUDIT_SOURCES = ['defillama', 'derived'] as const satisfies readonly PriceSource[]
export type AuditSource = (typeof AUDIT_SOURCES)[number]

export interface ExpectedTuple {
  chain: string
  token: string
  timestamp: number
  source: AuditSource
  kind: AuditKind
}

export interface CoverageReport {
  expected: number
  present: number
  missing: ExpectedTuple[]
  missingByChain: Record<string, number>
  missingBySource: Record<AuditSource, number>
  missingByKind: Record<AuditKind, number>
}

export function expectedTuples(allVaults: NormalizedVault[], timestamps: number[]): ExpectedTuple[] {
  const vaults = allVaults.filter((vault) => !vault.isRetired && !vault.isHidden && vault.tvl > 0)
  const tokens = new Map<string, Omit<ExpectedTuple, 'timestamp'>>()
  const add = (chain: string, token: string, kind: AuditKind, source: AuditSource) => {
    const key = `${chain}:${token.toLowerCase()}:${source}`
    if (!tokens.has(key)) tokens.set(key, { chain, token, kind, source })
  }
  for (const vault of vaults) {
    add(vault.chain, vault.vaultToken, 'vault', 'defillama')
    add(vault.chain, vault.vaultToken, 'vault', 'derived')
  }
  for (const vault of vaults) add(vault.chain, vault.underlyingToken, 'underlying', 'defillama')
  return [...tokens.values()].flatMap((token) => timestamps.map((timestamp) => ({ ...token, timestamp })))
}

export function auditCoverage(
  expected: ExpectedTuple[],
  existing: Partial<Record<PriceSource, Set<string>>>
): CoverageReport {
  const missing = expected.filter(
    (tuple) => !existing[tuple.source]?.has(`${tuple.chain}:${tuple.token}:${tuple.timestamp}`)
  )
  const missingByChain: Record<string, number> = {}
  const missingBySource: Record<AuditSource, number> = { defillama: 0, derived: 0 }
  const missingByKind: Record<AuditKind, number> = { underlying: 0, vault: 0 }
  for (const tuple of missing) {
    missingByChain[tuple.chain] = (missingByChain[tuple.chain] ?? 0) + 1
    missingBySource[tuple.source] += 1
    missingByKind[tuple.kind] += 1
  }
  return {
    expected: expected.length,
    present: expected.length - missing.length,
    missing,
    missingByChain,
    missingBySource,
    missingByKind
  }
}

export function auditFailed(report: CoverageReport, missingRpc: number[], warmupFailed = false): boolean {
  return warmupFailed || missingRpc.length > 0 || report.missing.length > 0
}
