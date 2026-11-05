import { expect, it } from 'vitest'
import type { NormalizedVault } from '../../scripts/lib/kong-vaults'
import { auditCoverage, auditFailed, expectedTuples } from '../../scripts/lib/price-audit'

const vault = (vaultToken: string, underlyingToken: string, chain = 'ethereum') =>
  ({ chain, chainId: 1, vaultToken, underlyingToken, isRetired: false, isHidden: false, tvl: 1 }) as NormalizedVault

it('flags a token-day missing when no accepted price exists and present when any does', () => {
  const days = [10, 20]
  const expected = expectedTuples([vault('0xv', '0xu')], days)
  const report = auditCoverage(expected, new Set(['ethereum:0xv:10', 'ethereum:0xu:10', 'ethereum:0xu:20']))
  expect(report.expected).toBe(4)
  expect(report.present).toBe(3)
  expect(report.missing).toEqual([{ chain: 'ethereum', token: '0xv', kind: 'vault', timestamp: 20 }])
  expect(report.missingByKind).toEqual({ underlying: 0, vault: 1 })
  expect(auditFailed(report, [])).toBe(true)
})

it('accepts any source: a derived-only vault row and curve-only underlying row count as covered', () => {
  const report = auditCoverage(
    expectedTuples([vault('0xv', '0xu')], [10]),
    new Set(['ethereum:0xv:10', 'ethereum:0xu:10'])
  )
  expect(report.missing).toEqual([])
  expect(auditFailed(report, [])).toBe(false)
  expect(auditFailed(report, [1])).toBe(true)
  expect(auditFailed(report, [], true)).toBe(true)
})

it('deduplicates shared underlyings and nested vault tokens', () => {
  const tuples = expectedTuples([vault('0xv', '0xu'), vault('0xw', '0xu'), vault('0xs', '0xv')], [10])
  expect(tuples.map((tuple) => `${tuple.token}:${tuple.kind}`).sort()).toEqual([
    '0xs:vault',
    '0xu:underlying',
    '0xv:vault',
    '0xw:vault'
  ])
})

it('skips retired and hidden vaults but keeps zero-TVL vaults', () => {
  const tuples = expectedTuples(
    [
      { ...vault('0xr', '0xa'), isRetired: true },
      { ...vault('0xh', '0xc'), isHidden: true },
      { ...vault('0xz', '0xb'), tvl: 0 },
      vault('0xv', '0xa')
    ],
    [10]
  )
  expect(tuples.map((tuple) => `${tuple.token}:${tuple.kind}`)).toEqual([
    '0xz:vault',
    '0xv:vault',
    '0xb:underlying',
    '0xa:underlying'
  ])
})
