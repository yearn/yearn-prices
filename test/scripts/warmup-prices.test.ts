import { describe, expect, it } from 'vitest'
import {
  categorizeOnchainFailure,
  flattenResolvedPricePath,
  missingUnderlyingToken,
  resolvedPathTokenPriceWrites
} from '../../scripts/warmup-prices'
import { RecursiveDependencyError } from '../../src/sources/onchain/errors'
import type { PriceResolutionFailure, ResolvedPricePath } from '../../src/sources/onchain/types'

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
    ['unsupported', [], 'not-found']
  ] as const)('maps %s failures to %s', (reason, attempts, category) => {
    expect(categorizeOnchainFailure({ reason, token: ROOT, attempts })).toBe(category)
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
