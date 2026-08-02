import { describe, expect, test } from 'vitest'
import { selectEodPriceEvidence } from '../src/evidence'
import type { PriceEvidenceCandidate } from '../src/types'

const EOD = 1_704_153_599

function candidate(overrides: Partial<PriceEvidenceCandidate> = {}): PriceEvidenceCandidate {
  return {
    chain: 'ethereum',
    token: '0x0000000000000000000000000000000000000001',
    requestedTimestamp: EOD,
    observedTimestamp: EOD,
    observationDistance: 0,
    observationOffsetSeconds: 0,
    observationDirection: 'exact',
    priceUsd: 100,
    symbol: 'TEST',
    confidence: 0.99,
    source: 'defillama',
    adapter: 'defillama-historical',
    classification: 'observed',
    quality: 'exact',
    blockNumber: null,
    inputs: [],
    validationStatus: 'validated',
    failureReason: null,
    metadata: {},
    ...overrides,
  }
}

describe('EOD price evidence selection', () => {
  test('returns unavailable rather than creating a stablecoin peg', () => {
    expect(selectEodPriceEvidence(EOD, [])).toMatchObject({
      selected: null,
      validation: { status: 'unavailable', failureClass: 'not-found' },
    })
  })

  test('rejects candidates stored under a different day key', () => {
    const result = selectEodPriceEvidence(EOD, [
      candidate({ requestedTimestamp: EOD - 1, observedTimestamp: EOD - 1 }),
    ])
    expect(result.selected).toBeNull()
    expect(result.validation.failureReason).toContain('wrong EOD key')
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid price %s',
    priceUsd => {
      const result = selectEodPriceEvidence(EOD, [candidate({ priceUsd })])
      expect(result.selected).toBeNull()
      expect(result.validation.failureClass).toBe('invalid')
    },
  )

  test('preserves but never selects automatic stable-peg evidence', () => {
    const stablePeg = candidate({
      source: 'stable-peg',
      priceUsd: 1,
      classification: 'legacy',
      quality: 'legacy',
      validationStatus: 'legacy-unvalidated',
    })
    const result = selectEodPriceEvidence(EOD, [stablePeg])
    expect(result.selected).toBeNull()
    expect(result.candidates).toEqual([stablePeg])
    expect(result.validation.failureReason).toContain('automatic peg evidence')
  })

  test('requires an explicit acceptance policy for legacy evidence', () => {
    const result = selectEodPriceEvidence(EOD, [
      candidate({ classification: 'legacy', quality: 'legacy', validationStatus: 'legacy-unvalidated' }),
    ])
    expect(result.selected).toBeNull()
    expect(result.validation.failureReason).toContain('acceptance policy')
  })

  test('rejects structurally incomplete derived evidence', () => {
    const result = selectEodPriceEvidence(EOD, [
      candidate({ classification: 'derived', adapter: 'pool-nav', inputs: [] }),
    ])
    expect(result.selected).toBeNull()
    expect(result.validation.failureReason).toContain('no recursive inputs')
  })

  test('preserves recursive input provenance and propagated quality', () => {
    const derived = candidate({
      classification: 'derived',
      quality: 'near-eod',
      source: 'derived',
      adapter: 'erc-4626',
      inputs: [{
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000002',
        observedTimestamp: EOD - 60,
        priceUsd: 1,
        source: 'defillama',
        adapter: 'defillama-historical',
        classification: 'observed',
        quality: 'near-eod',
        conversion: { convertToAssets: '1050000' },
      }],
    })
    expect(selectEodPriceEvidence(EOD, [derived]).selected?.inputs).toEqual(derived.inputs)
  })

  test('selects deterministically by classification, quality, source, and adapter', () => {
    const estimated = candidate({
      source: 'defillama-coingecko-alias',
      classification: 'estimated',
      quality: 'fallback',
      adapter: 'alias',
    })
    const observed = candidate({ source: 'on-chain-oracle', adapter: 'oracle' })
    expect(selectEodPriceEvidence(EOD, [estimated, observed]).selected).toEqual(observed)
  })

  test('quarantines independent source disagreement without averaging', () => {
    const result = selectEodPriceEvidence(EOD, [
      candidate({ priceUsd: 100, source: 'defillama' }),
      candidate({ priceUsd: 80, source: 'on-chain-oracle' }),
    ])
    expect(result.selected).toBeNull()
    expect(result.candidates).toHaveLength(2)
    expect(result.validation).toMatchObject({
      status: 'quarantined',
      failureClass: 'disagreement',
      disagreementBps: 2_000,
    })
  })

  test('does not mislabel provider aliases as independent evidence', () => {
    const result = selectEodPriceEvidence(EOD, [
      candidate({ priceUsd: 100, source: 'defillama' }),
      candidate({
        priceUsd: 80,
        source: 'defillama-coingecko-alias',
        classification: 'estimated',
        quality: 'fallback',
      }),
    ])
    expect(result.selected?.source).toBe('defillama')
    expect(result.validation.disagreementBps).toBeNull()
  })
})
