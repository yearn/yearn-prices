import { describe, expect, it, vi } from 'vitest'
import {
  type CurveWarmupDeps,
  categorizeOnchainFailure,
  deepestFailedToken,
  failureAttempts,
  flattenResolvedPricePath,
  type NormalizedVault,
  type OnchainWarmupDeps,
  resolveAliasRoot,
  resolvedPathTokenPriceWrites,
  type WarmupStats,
  warmCurveFallbackPrices,
  warmDirectPrices,
  warmOnchainPrices
} from '../../scripts/warmup-prices'
import { ApiError } from '../../src/http/errors'
import { RecursiveDependencyError, RetryablePricingError } from '../../src/sources/onchain/errors'
import type {
  PriceResolutionFailure,
  RecursivePriceResult,
  RecursivePriceTarget,
  ResolvedPricePath
} from '../../src/sources/onchain/types'
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
        symbol: 'MID',
        confidence: 0.5,
        source: 'derived',
        adapter: 'intermediate',
        inputs: [
          {
            chainId: 1,
            token: LEAF,
            observedTimestamp: 100,
            priceUsd: 2,
            symbol: 'LEAF',
            confidence: 0.8,
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
        symbol: 'MID',
        confidence: 0.5,
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
        symbol: 'MID',
        confidence: 0.5,
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
    ['unsupported', [], 'not-found'],
    ['unsupported', [{ adapter: 'market-price', reason: 'unsupported', error: 'not found in db' }], 'not-found']
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
          symbol: 'LEAF',
          confidence: 0.42,
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
        symbol: 'LEAF',
        confidence: 0.42,
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

  it('categorizes a dependency with no price as not-found and an adapter refusal as unsupported', () => {
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
    expect(categorizeOnchainFailure({ reason: 'unsupported', token: ROOT, attempts: [] })).toBe('not-found')
    expect(
      categorizeOnchainFailure({
        reason: 'unsupported',
        token: ROOT,
        attempts: [{ adapter: 'lp', reason: 'unsupported', error: 'not an lp' }]
      })
    ).toBe('unsupported')
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

    expect(deepestFailedToken(rootFailure)).toBe(LEAF)
    expect(failureAttempts(rootFailure).map((attempt) => [attempt.token, attempt.adapter])).toEqual([
      [ROOT, 'root'],
      [INTERMEDIATE, 'intermediate']
    ])
  })
})

const VAULT_TOKEN = '0x4444444444444444444444444444444444444444' as const
const UNDERLYING_TOKEN = '0x5555555555555555555555555555555555555555' as const

function makeStats(): WarmupStats {
  return {
    cacheHits: 0,
    apiCalls: 0,
    retries: 0,
    failures: 0,
    insertedDirect: 0,
    onchainWrites: 0,
    insertedDerived: 0,
    insertedCurve: 0,
    onchainRetryable: 0,
    onchainInvalid: 0,
    onchainUnsupported: 0,
    onchainNotFound: 0
  }
}

function makeVault(): NormalizedVault {
  return {
    chain: 'ethereum',
    chainId: 1,
    vaultToken: VAULT_TOKEN,
    underlyingToken: UNDERLYING_TOKEN,
    symbol: 'VLT',
    apiVersion: null,
    decimals: 18
  }
}

function existingRecord(token: string, timestamp: number) {
  return { chain: 'ethereum', token, timestamp, price: 1, confidence: null, source: 'db' as const, symbol: null }
}

function successPath(target: RecursivePriceTarget): ResolvedPricePath {
  return {
    chainId: target.chainId,
    token: target.token,
    requestedTimestamp: target.timestamp,
    observedTimestamp: target.timestamp ?? 0,
    priceUsd: 3,
    symbol: 'TKN',
    confidence: 0.9,
    source: 'defillama',
    adapter: 'defillama',
    blockNumber: null,
    metadata: {},
    inputs: []
  }
}

function makeDeps(over: Partial<OnchainWarmupDeps>): OnchainWarmupDeps {
  return {
    pool: {} as OnchainWarmupDeps['pool'],
    defiLlama: {} as OnchainWarmupDeps['defiLlama'],
    getBatch: async () => [],
    insert: async () => {},
    makePricer: () => ({
      resolvePath: async (): Promise<RecursivePriceResult> => ({
        path: null,
        failure: { reason: 'unsupported', token: '', attempts: [] }
      }),
      resolvedPaths: () => []
    }),
    ...over
  }
}

describe('warmOnchainPrices orchestration', () => {
  const timestamps = [100]

  it('skips requests already stored and writes nothing', async () => {
    const stats = makeStats()
    let inserted = 0
    let priced = 0
    await warmOnchainPrices(
      [makeVault()],
      timestamps,
      stats,
      new Set(),
      makeDeps({
        getBatch: async () => [existingRecord(VAULT_TOKEN, 100), existingRecord(UNDERLYING_TOKEN, 100)],
        insert: async () => {
          inserted += 1
        },
        makePricer: () => ({
          resolvePath: async (target) => {
            priced += 1
            return { path: successPath(target), failure: null }
          },
          resolvedPaths: () => []
        })
      })
    )
    expect(priced).toBe(0)
    expect(inserted).toBe(0)
    expect(stats.onchainWrites).toBe(0)
  })

  it("skips today's slot instead of resolving a timestamp that has not happened", async () => {
    const stats = makeStats()
    let priced = 0
    await warmOnchainPrices(
      [makeVault()],
      [normalizeToEndOfDay(Math.floor(Date.now() / 1000))],
      stats,
      new Set(),
      makeDeps({
        makePricer: () => ({
          resolvePath: async (target) => {
            priced += 1
            return { path: successPath(target), failure: null }
          },
          resolvedPaths: () => []
        })
      })
    )
    expect(priced).toBe(0)
    expect(stats.onchainWrites).toBe(0)
    expect(stats.onchainNotFound + stats.onchainUnsupported + stats.onchainRetryable).toBe(0)
  })

  it('reports a transient failure as retryable and never as not-found', async () => {
    const stats = makeStats()
    let priced = 0
    await warmOnchainPrices(
      [makeVault()],
      timestamps,
      stats,
      new Set([`ethereum:${UNDERLYING_TOKEN}:100`]),
      makeDeps({
        // The other request is already stored, so only the transient one remains.
        getBatch: async () => [existingRecord(VAULT_TOKEN, 100)],
        makePricer: () => ({
          resolvePath: async (target) => {
            priced += 1
            return { path: successPath(target), failure: null }
          },
          resolvedPaths: () => []
        })
      })
    )
    expect(stats.onchainRetryable).toBe(1)
    expect(stats.onchainNotFound).toBe(0)
    expect(priced).toBe(0)
  })

  it('persists a resolved path and counts the inserted writes', async () => {
    const stats = makeStats()
    const writes: string[] = []
    await warmOnchainPrices(
      [makeVault()],
      timestamps,
      stats,
      new Set(),
      makeDeps({
        insert: async (_pool, batch) => {
          for (const write of batch) {
            writes.push(write.token)
          }
        },
        makePricer: () => ({
          resolvePath: async (target) => ({ path: successPath(target), failure: null }),
          resolvedPaths: () => []
        })
      })
    )
    expect(writes.sort()).toEqual([UNDERLYING_TOKEN, VAULT_TOKEN].sort())
    expect(stats.onchainWrites).toBe(2)
    expect(stats.onchainNotFound).toBe(0)
  })

  it('records a failed resolution in the category stats and the printed report', async () => {
    const stats = makeStats()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await warmOnchainPrices([makeVault()], timestamps, stats, new Set(), makeDeps({}))
    const lines = warn.mock.calls.map((call) => String(call[0]))
    warn.mockRestore()

    expect(stats.onchainNotFound).toBe(2)
    expect(lines.filter((line) => line.startsWith('[not-found]'))).toHaveLength(2)
  })

  it('dates a standalone resolved child by its observed day, not the requested one', async () => {
    const stats = makeStats()
    const writes: { token: string; timestamp: number }[] = []
    const observed = normalizeToEndOfDay(1_700_000_000 - 86_400)
    const resolvedLeaf: ResolvedPricePath = {
      ...successPath({ chainId: 1, token: LEAF, timestamp: 100 }),
      observedTimestamp: observed,
      source: 'defillama'
    }
    await warmOnchainPrices(
      [makeVault()],
      timestamps,
      stats,
      new Set(),
      makeDeps({
        getBatch: async () => [existingRecord(VAULT_TOKEN, 100)],
        insert: async (_pool, batch) => {
          for (const write of batch) {
            writes.push({ token: write.token, timestamp: write.timestamp })
          }
        },
        makePricer: () => ({
          resolvePath: async (): Promise<RecursivePriceResult> => ({
            path: null,
            failure: { reason: 'unsupported', token: UNDERLYING_TOKEN, attempts: [] }
          }),
          resolvedPaths: () => [resolvedLeaf]
        })
      })
    )
    expect(writes).toEqual([{ token: LEAF, timestamp: observed }])
  })

  it('persists underlyings that resolved even when the requested token failed', async () => {
    const stats = makeStats()
    const writes: string[] = []
    const resolvedLeaf = successPath({ chainId: 1, token: LEAF, timestamp: 100 })
    await warmOnchainPrices(
      [makeVault()],
      timestamps,
      stats,
      new Set(),
      makeDeps({
        getBatch: async () => [existingRecord(VAULT_TOKEN, 100)],
        insert: async (_pool, batch) => {
          for (const write of batch) {
            writes.push(write.token)
          }
        },
        makePricer: () => ({
          resolvePath: async (): Promise<RecursivePriceResult> => ({
            path: null,
            failure: { reason: 'unsupported', token: UNDERLYING_TOKEN, attempts: [] }
          }),
          resolvedPaths: () => [resolvedLeaf]
        })
      })
    )
    expect(writes).toEqual([LEAF])
    expect(stats.onchainWrites).toBe(1)
    expect(stats.onchainNotFound).toBe(1)
  })
})

describe('resolveAliasRoot', () => {
  const target: RecursivePriceTarget = { chainId: 1, token: ROOT, timestamp: 100 }

  it('returns the path when the alias resolves', async () => {
    const resolved = successPath(target)
    expect(await resolveAliasRoot(async () => resolved, target)).toEqual({ path: resolved, retryable: false })
  })

  it('returns a non-retryable miss when the alias has no price', async () => {
    expect(await resolveAliasRoot(async () => null, target)).toEqual({ path: null, retryable: false })
  })

  it.each([
    [new ApiError('RATE_LIMITED', 'boom'), true],
    [new RetryablePricingError('rpc down'), true],
    [new Error('bug'), false]
  ])('classifies %s as retryable=%s and logs it', async (error, retryable) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      resolveAliasRoot(async () => {
        throw error
      }, target)
    ).resolves.toEqual({ path: null, retryable, error })
    expect(logged).toHaveBeenCalledWith('Alias lookup failed', { chainId: 1, token: ROOT, timestamp: 100 }, error)
    logged.mockRestore()
  })
})

describe('warmCurveFallbackPrices', () => {
  const PRICED = 100
  const UNPRICED = 200

  async function run(existing: Set<string>): Promise<number> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clients = 0
    const sources: (string | undefined)[] = []
    const deps: CurveWarmupDeps = {
      pool: {} as CurveWarmupDeps['pool'],
      getExisting: async (_pool, _requests, source) => {
        sources.push(source)
        return existing
      },
      getClient: () => {
        clients += 1
        return null
      }
    }
    await warmCurveFallbackPrices([makeVault()], [PRICED, UNPRICED], makeStats(), deps)
    warn.mockRestore()
    expect(sources).toEqual([undefined])
    return clients
  }

  it('skips an underlying already priced by any source and still fills the unpriced one', async () => {
    expect(await run(new Set([`ethereum:${UNDERLYING_TOKEN}:${PRICED}`]))).toBe(1)
  })

  it('fills every slot when nothing is stored', async () => {
    expect(await run(new Set())).toBe(2)
  })
})

describe('transient failure keys', () => {
  it('writes keys that warmOnchainPrices reads back as retryable', async () => {
    const day = normalizeToEndOfDay(1_700_000_000)
    const today = normalizeToEndOfDay(Math.floor(Date.now() / 1000))
    const transientFailures = new Set<string>()
    const stats = makeStats()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const directDeps: DirectWarmupDeps = {
      pool: {} as DirectWarmupDeps['pool'],
      defiLlama: {
        getBatchHistorical: async () => {
          throw new Error('defillama down')
        }
      } as unknown as DirectWarmupDeps['defiLlama'],
      getExisting: async () => new Set<string>(),
      insert: async () => {}
    }
    await warmDirectPrices([makeVault()], [day, today], stats, transientFailures, directDeps)

    // Today's slot is fetched at `now`, so its key only matches what
    // warmOnchainPrices reads if the write side normalizes it back to the day.
    expect([...transientFailures].sort()).toEqual(
      [
        `ethereum:${VAULT_TOKEN}:${day}`,
        `ethereum:${UNDERLYING_TOKEN}:${day}`,
        `ethereum:${VAULT_TOKEN}:${today}`,
        `ethereum:${UNDERLYING_TOKEN}:${today}`
      ].sort()
    )

    let priced = 0
    await warmOnchainPrices(
      [makeVault()],
      [day],
      stats,
      transientFailures,
      makeDeps({
        makePricer: () => ({
          resolvePath: async (target) => {
            priced += 1
            return { path: successPath(target), failure: null }
          },
          resolvedPaths: () => []
        })
      })
    )
    errors.mockRestore()
    warns.mockRestore()

    expect(priced).toBe(0)
    expect(stats.onchainRetryable).toBe(2)
    expect(stats.onchainNotFound).toBe(0)
  })
})
