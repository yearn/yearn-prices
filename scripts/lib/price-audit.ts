import type { NormalizedVault } from './kong-vaults'

export type AuditKind = 'underlying' | 'vault'

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

export function expectedTuples(allVaults: NormalizedVault[], timestamps: number[]): ExpectedTuple[] {
  const vaults = allVaults.filter((vault) => !vault.isRetired && !vault.isHidden)
  const tokens = new Map<string, Omit<ExpectedTuple, 'timestamp'>>()
  const add = (chain: string, token: string, kind: AuditKind) => {
    const key = `${chain}:${token.toLowerCase()}`
    if (!tokens.has(key)) tokens.set(key, { chain, token, kind })
  }
  for (const vault of vaults) add(vault.chain, vault.vaultToken, 'vault')
  for (const vault of vaults) add(vault.chain, vault.underlyingToken, 'underlying')
  return [...tokens.values()].flatMap((token) => timestamps.map((timestamp) => ({ ...token, timestamp })))
}

export function auditCoverage(expected: ExpectedTuple[], priced: Set<string>): CoverageReport {
  const missing = expected.filter((tuple) => !priced.has(`${tuple.chain}:${tuple.token}:${tuple.timestamp}`))
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

export function auditFailed(report: CoverageReport, missingRpc: number[], warmupFailed = false): boolean {
  return warmupFailed || missingRpc.length > 0 || report.missing.length > 0
}
