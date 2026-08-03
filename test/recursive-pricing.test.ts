import { describe, expect, test } from 'vitest'
import type {
  RecursivePriceAdapter,
  RecursivePriceTarget,
  ResolvedPricePath,
} from '../src/recursive-pricing'
import {
  InvalidPricingError,
  isRetryablePricingError,
  RecursivePriceEngine,
  RetryablePricingError,
} from '../src/recursive-pricing'

const WRAPPER = '0x0000000000000000000000000000000000000001'
const UNDERLYING = '0x0000000000000000000000000000000000000002'
const SECOND_UNDERLYING = '0x0000000000000000000000000000000000000003'
const REQUESTED_TIMESTAMP = 1_700_006_399

function target(token = WRAPPER, requestedTimestamp = REQUESTED_TIMESTAMP): RecursivePriceTarget {
  return {
    chain: 'ethereum',
    token,
    requestedTimestamp,
    blockNumber: 19_000_000,
  }
}

function marketPath(
  token: string,
  priceUsd: number,
  overrides: Partial<ResolvedPricePath> = {},
): ResolvedPricePath {
  return {
    chain: 'ethereum',
    token,
    requestedTimestamp: REQUESTED_TIMESTAMP,
    observedTimestamp: REQUESTED_TIMESTAMP - 60,
    priceUsd,
    symbol: 'TEST',
    confidence: 0.99,
    source: 'defillama',
    adapter: 'defillama-historical',
    classification: 'observed',
    quality: 'near-eod',
    blockNumber: null,
    inputs: [],
    metadata: {},
    ...overrides,
  }
}

describe('recursive historical pricing', () => {
  test('retains recursive provenance and propagates the weakest input quality', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'test-wrapper',
      async resolve(priceTarget, context) {
        if (priceTarget.token.toLowerCase() !== WRAPPER.toLowerCase()) return null
        const underlying = await context.require(target(UNDERLYING), 'wrapper underlying')
        return {
          priceUsd: underlying.priceUsd * 1.25,
          inputs: [{ path: underlying, conversion: { assetsPerShare: 1.25 } }],
          metadata: { assetsPerShare: 1.25 },
          quality: 'exact',
        }
      },
    }
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()
        ? marketPath(priceTarget.token, 2)
        : null,
      [adapter],
    )

    const result = await engine.resolve(target())

    expect(result.failure).toBeNull()
    expect(result.path).toMatchObject({
      adapter: 'test-wrapper',
      priceUsd: 2.5,
      observedTimestamp: REQUESTED_TIMESTAMP - 60,
      classification: 'derived',
      quality: 'near-eod',
      inputs: [{
        token: UNDERLYING,
        priceUsd: 2,
        adapter: 'defillama-historical',
        conversion: { assetsPerShare: 1.25 },
      }],
    })
  })

  test('propagates estimated canonical proxy provenance into derived results', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'test-pool-nav',
      async resolve(priceTarget, context) {
        if (priceTarget.token.toLowerCase() !== WRAPPER.toLowerCase()) return null
        const underlying = await context.require(target(UNDERLYING), 'pool constituent')
        return {
          priceUsd: underlying.priceUsd,
          inputs: [{ path: underlying, conversion: { reserveShare: 1 } }],
          metadata: {},
          quality: 'exact',
        }
      },
    }
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()
        ? marketPath(priceTarget.token, 0.9973, {
            source: 'defillama-canonical-market-proxy',
            adapter: 'defillama-canonical-market-proxy',
            classification: 'estimated',
            quality: 'fallback',
          })
        : null,
      [adapter],
    )

    await expect(engine.resolve(target())).resolves.toMatchObject({
      path: {
        classification: 'derived',
        quality: 'fallback',
        inputs: [{
          source: 'defillama-canonical-market-proxy',
          adapter: 'defillama-canonical-market-proxy',
          classification: 'estimated',
          quality: 'fallback',
        }],
      },
      failure: null,
    })
  })

  test('fails closed when a recursive dependency cycles', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'cyclic-wrapper',
      async resolve(priceTarget, context) {
        const child = priceTarget.token.toLowerCase() === WRAPPER.toLowerCase()
          ? UNDERLYING
          : WRAPPER
        const input = await context.require(target(child), 'cyclic child')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      },
    }
    const engine = new RecursivePriceEngine(async () => null, [adapter])

    expect(await engine.resolve(target())).toMatchObject({
      path: null,
      failure: {
        reason: 'cycle',
        attempts: [{ adapter: 'cyclic-wrapper', reason: 'cycle' }],
      },
    })
  })

  test('fails closed at the configured recursion depth', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'linked-wrapper',
      async resolve(priceTarget, context) {
        const child = priceTarget.token.toLowerCase() === WRAPPER.toLowerCase()
          ? UNDERLYING
          : SECOND_UNDERLYING
        const input = await context.require(target(child), 'linked child')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      },
    }
    const engine = new RecursivePriceEngine(async () => null, [adapter], 2)

    expect(await engine.resolve(target())).toMatchObject({
      path: null,
      failure: { reason: 'max-depth' },
    })
  })

  test('rejects future and non-positive market observations', async () => {
    const future = new RecursivePriceEngine(async priceTarget => marketPath(priceTarget.token, 1, {
      observedTimestamp: REQUESTED_TIMESTAMP + 1,
    }), [])
    const zero = new RecursivePriceEngine(async priceTarget => marketPath(priceTarget.token, 0), [])

    await expect(future.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'invalid' },
    })
    await expect(zero.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'invalid' },
    })
  })

  test('rejects automatic peg evidence from direct and recursive paths', async () => {
    const peg = new RecursivePriceEngine(async priceTarget => marketPath(priceTarget.token, 1, {
      source: 'stable-peg',
    }), [])
    const adapter: RecursivePriceAdapter = {
      name: 'pegged-wrapper',
      async resolve(priceTarget, context) {
        if (priceTarget.token.toLowerCase() !== WRAPPER.toLowerCase()) return null
        const input = await context.require(target(UNDERLYING), 'wrapper underlying')
        return { priceUsd: 1, inputs: [{ path: input }], metadata: {} }
      },
    }
    const recursivePeg = new RecursivePriceEngine(async priceTarget => (
      priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()
        ? marketPath(priceTarget.token, 1, { source: 'stable-peg' })
        : null
    ), [adapter])

    await expect(peg.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'invalid' },
    })
    await expect(recursivePeg.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'invalid' },
    })
  })

  test('rejects derived quotes without complete recursive inputs', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'incomplete-pool',
      async resolve() {
        return { priceUsd: 100, inputs: [], metadata: {} }
      },
    }
    const engine = new RecursivePriceEngine(async () => null, [adapter])

    expect(await engine.resolve(target())).toMatchObject({
      path: null,
      failure: {
        reason: 'invalid',
        attempts: [{ adapter: 'incomplete-pool', reason: 'invalid' }],
      },
    })
  })

  test('keeps retryable failures distinct from unsupported assets', async () => {
    const retryable = new RecursivePriceEngine(async () => {
      throw new RetryablePricingError('Price API returned HTTP 503')
    }, [])
    const invalid = new RecursivePriceEngine(async () => {
      throw new InvalidPricingError('Malformed market response')
    }, [])
    const unsupported = new RecursivePriceEngine(async () => null, [])

    await expect(retryable.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'retryable' },
    })
    await expect(invalid.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'invalid' },
    })
    await expect(unsupported.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'unsupported' },
    })
  })

  test('classifies opaque RPC transport failures as retryable without retrying contract reverts', () => {
    const rpcFailure = new Error('An unknown RPC error occurred. Cannot destructure property error from null')
    rpcFailure.name = 'UnknownRpcError'

    expect(isRetryablePricingError(rpcFailure)).toBe(true)
    expect(isRetryablePricingError(new Error('Contract reverted and returned no data'))).toBe(false)
  })

  test('reuses successful paths without reusing state across timestamps', async () => {
    let calls = 0
    const engine = new RecursivePriceEngine(async priceTarget => {
      calls += 1
      return marketPath(priceTarget.token, priceTarget.requestedTimestamp, {
        requestedTimestamp: priceTarget.requestedTimestamp,
        observedTimestamp: priceTarget.requestedTimestamp,
        quality: 'exact',
      })
    }, [])

    expect((await engine.resolve(target()).then(result => result.path))?.priceUsd).toBe(REQUESTED_TIMESTAMP)
    expect((await engine.resolve(target()).then(result => result.path))?.priceUsd).toBe(REQUESTED_TIMESTAMP)
    expect((await engine.resolve(target(WRAPPER, REQUESTED_TIMESTAMP + 86_400)).then(result => result.path))?.priceUsd)
      .toBe(REQUESTED_TIMESTAMP + 86_400)
    expect(calls).toBe(2)
  })

  test('collects market and every successful root adapter before selection', async () => {
    const adapter: RecursivePriceAdapter = {
      name: 'independent-wrapper-nav',
      async resolve(priceTarget, context) {
        if (priceTarget.token.toLowerCase() !== WRAPPER.toLowerCase()) return null
        const underlying = await context.require(target(UNDERLYING), 'wrapper underlying')
        return {
          priceUsd: 101,
          inputs: [{ path: underlying }],
          metadata: { independenceKey: 'wrapper-nav' },
        }
      },
    }
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()
        ? marketPath(priceTarget.token, 1)
        : marketPath(priceTarget.token, 100),
      [adapter],
    )

    const result = await engine.resolveCandidates(target())

    expect(result).toMatchObject({ path: { priceUsd: 100 }, failure: null })
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: 'defillama-historical', priceUsd: 100 }),
      expect.objectContaining({ adapter: 'independent-wrapper-nav', priceUsd: 101 }),
    ]))
  })

  test('quarantines disagreement between independently derived root adapters', async () => {
    const derivedAdapter = (name: string, priceUsd: number): RecursivePriceAdapter => ({
      name,
      async resolve(priceTarget, context) {
        if (priceTarget.token.toLowerCase() !== WRAPPER.toLowerCase()) return null
        const underlying = await context.require(target(UNDERLYING), 'pool constituent')
        return { priceUsd, inputs: [{ path: underlying }], metadata: {} }
      },
    })
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()
        ? marketPath(priceTarget.token, 1)
        : null,
      [derivedAdapter('reserve-nav-a', 100), derivedAdapter('reserve-nav-b', 80)],
    )

    const result = await engine.resolveCandidates(target())

    expect(result).toMatchObject({
      path: null,
      failure: { reason: 'disagreement' },
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.failure?.attempts.at(-1)?.error).toContain('2000.00 bps')
  })
})
