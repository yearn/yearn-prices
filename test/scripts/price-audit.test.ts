import { expect, it } from 'vitest'
import type { NormalizedVault } from '../../scripts/lib/kong-vaults'
import { auditCoverage, expectedTuples } from '../../scripts/lib/price-audit'

const vault = (vaultToken: string, underlyingToken: string, chain = 'ethereum') =>
  ({ chain, chainId: 1, vaultToken, underlyingToken }) as NormalizedVault

it('flags only tuples with no accepted source', () => {
  const expected = expectedTuples([vault('0xv', '0xu'), vault('0xw', '0xu')], [10, 20])
  expect(expected).toHaveLength(6)

  const report = auditCoverage(expected, {
    defillama: new Set(['ethereum:0xu:10', 'ethereum:0xu:20']),
    derived: new Set(['ethereum:0xv:10', 'ethereum:0xw:20']),
    curve: new Set(['ethereum:0xw:10'])
  })

  expect(report.present).toBe(4)
  expect(report.missing.map((tuple) => `${tuple.token}:${tuple.timestamp}`)).toEqual(['0xv:20', '0xw:10'])
  expect(report.missingByChain).toEqual({ ethereum: 2 })
  expect(report.missingByKind).toEqual({ underlying: 0, vault: 2 })
})

it('passes when a vault of a vault is only derived', () => {
  const expected = expectedTuples([vault('0xv', '0xu'), vault('0xs', '0xv')], [10])
  const report = auditCoverage(expected, {
    defillama: new Set(['ethereum:0xu:10']),
    derived: new Set(['ethereum:0xv:10', 'ethereum:0xs:10'])
  })
  expect(report.missing).toEqual([])
})
