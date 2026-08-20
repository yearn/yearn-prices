import { describe, expect, it } from 'vitest'
import {
  categorizeOnchainFailure,
  flattenResolvedPricePath,
  missingUnderlyingToken,
  resolvedPathTokenPriceWrites
} from '../../scripts/warmup-prices'
import { RecursiveDependencyError } from '../../src/sources/onchain/errors'
import type { PriceResolutionFailure, ResolvedPricePath } from '../../src/sources/onchain/types'
import { normalizeToEndOfDay } from '../../src/utils'

const ROOT = '0x1111111111111111111111111111111111111111'
const INTERMEDIATE = '0x2222222222222222222222222222222222222222'
const LEAF = '0x3333333333333333333333333333333333333333'

function path(): ResolvedPricePath {
  return {
    chainId: 1,
    token: ROOT,
    requestedTimestamp: 100,
    observedTimestamp: 100,
    priceUsd: 6,
    symbol: 'ROOT',
    confidence: 0.9,
    source: 'derived',
    adapter: 'root',
    blockNumber: null,
    metadata: {},
    inputs: [
      {
        chainId: 1,
        token: INTERMEDIATE,
        observedTimestamp: 100,
        priceUsd: 3,
        source: 'derived',
        adapter: 'intermediate',
        inputs: [
          {
            chainId: 1,
            token: LEAF,
            observedTimestamp: 100,
            priceUsd: 2,
            source: 'db',
            adapter: 'db'
          }
        ]
      },
      {
        chainId: 1,
        token: INTERMEDIATE,
        observedTimestamp: 100,
        priceUsd: 3,
        source: 'derived',
        adapter: 'intermediate'
      }
    ]
  }
}

describe('warmup on-chain helpers', () => {
  it('flattens paths post-order, dedupes writes, and skips DB-backed nodes', () => {
    expect(flattenResolvedPricePath(path()).map((node) => node.token)).toEqual([LEAF, INTERMEDIATE, INTERMEDIATE, ROOT])

    expect(resolvedPathTokenPriceWrites(path())).toEqual([
      {
        chain: 'ethereum',
        token: INTERMEDIATE,
        timestamp: 100,
        price: 3,
        symbol: null,
        confidence: null,
        source: 'derived'
      },
      {
        chain: 'ethereum',
        token: ROOT,
        timestamp: 100,
        price: 6,
        symbol: 'ROOT',
        confidence: 0.9,
        source: 'derived'
      }
    ])
  })

  it.each([
    ['retryable', [], 'retryable'],
    ['budget', [], 'retryable'],
    ['invalid', [], 'invalid'],
    ['unsupported', [{ adapter: 'adapter', reason: 'unsupported', error: 'unsupported' }], 'unsupported'],
    ['cycle', [], 'unsupported'],
    ['max-depth', [], 'unsupported'],
    ['unsupported', [], 'unsupported']
  ] as const)('maps %s failures to %s', (reason, attempts, category) => {
    expect(categorizeOnchainFailure({ reason, token: ROOT, attempts })).toBe(category)
  })

  it('writes market-sourced leaves under their own observed day and adapter nodes under the requested day', () => {
    const requested = normalizeToEndOfDay(1_700_000_000)
    const observedLeafDay = normalizeToEndOfDay(requested - 86_400)
    const marketPath: ResolvedPricePath = {
      chainId: 1,
      token: ROOT,
      requestedTimestamp: requested,
      observedTimestamp: requested,
      priceUsd: 5,
      symbol: 'ROOT',
      confidence: null,
      source: 'derived',
      adapter: 'lp',
      blockNumber: null,
      metadata: {},
      inputs: [
        {
          chainId: 1,
          token: LEAF,
          observedTimestamp: observedLeafDay,
          priceUsd: 2,
          source: 'defillama',
          adapter: 'defillama'
        }
      ]
    }

    expect(resolvedPathTokenPriceWrites(marketPath)).toEqual([
      {
        chain: 'ethereum',
        token: LEAF,
        timestamp: observedLeafDay,
        price: 2,
        symbol: null,
        confidence: null,
        source: 'defillama'
      },
      {
        chain: 'ethereum',
        token: ROOT,
        timestamp: requested,
        price: 5,
        symbol: 'ROOT',
        confidence: null,
        source: 'derived'
      }
    ])
  })

  it('categorizes a dependency with no price as not-found and a bare token as unsupported', () => {
    const leafFailure: PriceResolutionFailure = { reason: 'unsupported', token: LEAF, attempts: [] }
    const rootFailure: PriceResolutionFailure = {
      reason: 'unsupported',
      token: ROOT,
      attempts: [
        {
          adapter: 'lp',
          reason: 'unsupported',
          error: 'missing underlying',
          cause: new RecursiveDependencyError('missing underlying', leafFailure)
        }
      ]
    }

    expect(categorizeOnchainFailure(rootFailure)).toBe('not-found')
    expect(categorizeOnchainFailure({ reason: 'unsupported', token: ROOT, attempts: [] })).toBe('unsupported')
  })

  it('lets a nested retryable or invalid failure win over an unsupported root', () => {
    const nest = (leaf: PriceResolutionFailure): PriceResolutionFailure => ({
      reason: 'unsupported',
      token: ROOT,
      attempts: [{ adapter: 'lp', reason: 'unsupported', error: 'x', cause: new RecursiveDependencyError('x', leaf) }]
    })

    expect(categorizeOnchainFailure(nest({ reason: 'retryable', token: LEAF, attempts: [] }))).toBe('retryable')
    expect(categorizeOnchainFailure(nest({ reason: 'invalid', token: LEAF, attempts: [] }))).toBe('invalid')
  })

  it('uses the deepest recursive dependency failure token as the missing underlying', () => {
    const leafFailure: PriceResolutionFailure = {
      reason: 'unsupported',
      token: LEAF,
      attempts: []
    }
    const intermediateFailure: PriceResolutionFailure = {
      reason: 'unsupported',
      token: INTERMEDIATE,
      attempts: [
        {
          adapter: 'intermediate',
          reason: 'unsupported',
          error: 'missing leaf',
          cause: new RecursiveDependencyError('missing leaf', leafFailure)
        }
      ]
    }
    const rootFailure: PriceResolutionFailure = {
      reason: 'unsupported',
      token: ROOT,
      attempts: [
        {
          adapter: 'root',
          reason: 'unsupported',
          error: 'missing intermediate',
          cause: new RecursiveDependencyError('missing intermediate', intermediateFailure)
        }
      ]
    }

    expect(missingUnderlyingToken(rootFailure)).toBe(LEAF)
  })
})
