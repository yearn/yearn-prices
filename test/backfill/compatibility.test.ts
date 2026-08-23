import { describe, expect, it } from 'vitest'
import { DefiLlamaAliasHistoricalSource } from '../../src/sources/defillama/alias'
import { SOURCE_PRIORITY } from '../../src/types'

/**
 * Spec section 13 compatibility guards for the contracts the historical gap
 * backfill borders but must not change. Broader warmup / route / cache
 * behavior stays covered by their own suites; these pin only what this work
 * could regress: the source ordering the recheck read depends on, and the
 * runtime alias provenance the backfill deliberately no longer mirrors.
 */
describe('backfill spec-13 compatibility', () => {
  it('keeps SOURCE_PRIORITY order untouched', () => {
    expect([...SOURCE_PRIORITY]).toEqual([
      'defillama',
      'on-chain-oracle',
      'bobs-api',
      'curve',
      'derived',
      'defillama-alias',
      'enso'
    ])
  })

  it('keeps direct and alias sources at distinct priorities', () => {
    const direct = SOURCE_PRIORITY.indexOf('defillama')
    const alias = SOURCE_PRIORITY.indexOf('defillama-alias')
    expect(direct).toBeGreaterThanOrEqual(0)
    expect(alias).toBeGreaterThan(direct)
  })

  it('keeps the runtime alias source writing defillama-alias', () => {
    const source = new DefiLlamaAliasHistoricalSource()
    expect(source.name).toBe('defillama-alias')
    expect(source.priority).toBe(30)
  })
})
