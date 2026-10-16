import { expect, it } from 'vitest'
import type { NormalizedVault } from '../../scripts/lib/kong-vaults'
import { auditCoverage, auditFailed, expectedTuples } from '../../scripts/lib/price-audit'

const vault = (vaultToken: string, underlyingToken: string, chain = 'ethereum') =>
  ({ chain, chainId: 1, vaultToken, underlyingToken, isRetired: false, tvl: 1 }) as NormalizedVault

it('reports every missing derived day even when DefiLlama coverage is complete', () => {
  const days = [10, 20, 30, 40, 50, 60, 70]
  const expected = expectedTuples([vault('0xv', '0xu')], days)
  const report = auditCoverage(expected, {
    defillama: new Set(days.flatMap((day) => [`ethereum:0xv:${day}`, `ethereum:0xu:${day}`]))
  })
  expect(report.expected).toBe(21)
  expect(report.present).toBe(14)
  expect(report.missing).toHaveLength(7)
  expect(report.missing.every((tuple) => tuple.source === 'derived' && tuple.token === '0xv')).toBe(true)
  expect(report.missingBySource).toEqual({ defillama: 0, derived: 7 })
  expect(auditFailed(report, [])).toBe(true)
})

it('does not substitute another source for a required DefiLlama row', () => {
  const report = auditCoverage(expectedTuples([vault('0xv', '0xu')], [10]), {
    derived: new Set(['ethereum:0xv:10', 'ethereum:0xu:10']),
    curve: new Set(['ethereum:0xu:10'])
  })
  expect(report.missingBySource).toEqual({ defillama: 2, derived: 0 })
})

it('deduplicates shared underlyings without dropping a nested vault source requirement', () => {
  const tuples = expectedTuples([vault('0xv', '0xu'), vault('0xw', '0xu'), vault('0xs', '0xv')], [10])
  expect(tuples).toHaveLength(7)
  const report = auditCoverage(tuples, {
    defillama: new Set(['ethereum:0xu:10', 'ethereum:0xv:10', 'ethereum:0xw:10', 'ethereum:0xs:10']),
    derived: new Set(['ethereum:0xv:10', 'ethereum:0xw:10', 'ethereum:0xs:10'])
  })
  expect(report.missing).toEqual([])
  expect(auditFailed(report, [])).toBe(false)
  expect(auditFailed(report, [1])).toBe(true)
  expect(auditFailed(report, [], true)).toBe(true)
})

it('skips retired and zero-TVL vaults', () => {
  const tuples = expectedTuples(
    [{ ...vault('0xr', '0xa'), isRetired: true }, { ...vault('0xz', '0xb'), tvl: 0 }, vault('0xv', '0xa')],
    [10]
  )
  expect(tuples.map((tuple) => `${tuple.token}:${tuple.source}`)).toEqual([
    '0xv:defillama',
    '0xv:derived',
    '0xa:defillama'
  ])
})
