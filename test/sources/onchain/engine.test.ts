import { describe, expect, it, vi } from 'vitest'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import { InvalidPricingError, RetryablePricingError } from '../../../src/sources/onchain/errors'
import type {
  MarketPriceResolver,
  RecursivePriceAdapter,
  ResolvedPricePath,
} from '../../../src/sources/onchain/types'

const SHARE = '0x1111111111111111111111111111111111111111'
const UNDERLYING = '0x2222222222222222222222222222222222222222'

function marketPath(token: string, priceUsd: number): ResolvedPricePath {
  return {
    chainId: 1,
    token,
    requestedTimestamp: null,
    observedTimestamp: 1_700_000_000,
    priceUsd,
    symbol: null,
    confidence: null,
    source: 'enso',
    adapter: 'enso',
    blockNumber: null,
    inputs: [],
    metadata: {},
  }
}

function marketFor(prices: Record<string, number>): MarketPriceResolver {
  return async (target) => {
    const price = prices[target.token.toLowerCase()]
    return price === undefined ? null : marketPath(target.token, price)
  }
}

function wrapperAdapter(rate: number, name = 'wrapper'): RecursivePriceAdapter {
  return {
    name,
    async resolve(target, context) {
      if (target.token.toLowerCase() !== SHARE) {
        return null
      }
      const input = await context.require({ ...target, token: UNDERLYING }, 'underlying')
      return {
        priceUsd: input.priceUsd * rate,
        inputs: [{ path: input, conversion: { rate } }],
        metadata: { rate },
      }
    },
  }
}

describe('RecursivePriceEngine', () => {
  it('prices a wrapper from its underlying market price', async () => {
    const engine = new RecursivePriceEngine(marketFor({ [UNDERLYING]: 2 }), [wrapperAdapter(1.5)])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.failure).toBeNull()
    expect(result.path?.priceUsd).toBe(3)
    expect(result.path?.adapter).toBe('wrapper')
    expect(result.path?.source).toBe('derived')
    expect(result.path?.inputs).toHaveLength(1)
    expect(result.path?.inputs[0]).toMatchObject({ token: UNDERLYING, priceUsd: 2 })
  })

  it('never asks the market for the root token', async () => {
    const market = vi.fn(marketFor({ [SHARE]: 99, [UNDERLYING]: 2 }))
    const engine = new RecursivePriceEngine(market, [wrapperAdapter(1.5)])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path?.priceUsd).toBe(3)
    expect(market).toHaveBeenCalledTimes(1)
    expect(market.mock.calls[0][0].token.toLowerCase()).toBe(UNDERLYING)
  })

  it('reports unsupported when no adapter matches', async () => {
    const engine = new RecursivePriceEngine(marketFor({}), [])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })

  it('propagates a transient child failure as retryable', async () => {
    const market: MarketPriceResolver = async () => {
      throw new RetryablePricingError('rpc down')
    }
    const engine = new RecursivePriceEngine(market, [wrapperAdapter(1.5)])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('retryable')
  })

  it('prefers retryable over unsupported when adapters disagree', async () => {
    const flaky: RecursivePriceAdapter = {
      name: 'flaky',
      async resolve() {
        throw new RetryablePricingError('timed out')
      },
    }
    const silent: RecursivePriceAdapter = { name: 'silent', resolve: async () => null }
    const engine = new RecursivePriceEngine(marketFor({}), [silent, flaky])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.failure?.reason).toBe('retryable')
    expect(result.failure?.attempts).toHaveLength(1)
  })

  it('stops a self-referencing token instead of recursing forever', async () => {
    const selfReferencing: RecursivePriceAdapter = {
      name: 'self',
      async resolve(target, context) {
        const input = await context.require({ ...target }, 'self')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      },
    }
    const engine = new RecursivePriceEngine(marketFor({}), [selfReferencing])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('cycle')
  })

  it('stops at the configured depth', async () => {
    const chain: RecursivePriceAdapter = {
      name: 'chain',
      async resolve(target, context) {
        const next = `0x${(BigInt(target.token) + 1n).toString(16).padStart(40, '0')}`
        const input = await context.require({ ...target, token: next }, 'next')
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      },
    }
    const engine = new RecursivePriceEngine(marketFor({}), [chain], 2)

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('max-depth')
  })

  it('rejects a non-positive adapter price', async () => {
    const broken: RecursivePriceAdapter = {
      name: 'broken',
      resolve: async () => ({ priceUsd: 0, inputs: [], metadata: {} }),
    }
    const engine = new RecursivePriceEngine(marketFor({}), [broken])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.failure?.reason).toBe('invalid')
  })

  it('resolves each token once per request', async () => {
    const market = vi.fn(marketFor({ [UNDERLYING]: 2 }))
    const engine = new RecursivePriceEngine(market, [
      {
        name: 'two-legs',
        async resolve(target, context) {
          if (target.token.toLowerCase() !== SHARE) return null
          const [left, right] = await Promise.all([
            context.require({ ...target, token: UNDERLYING }, 'left'),
            context.require({ ...target, token: UNDERLYING }, 'right'),
          ])
          return {
            priceUsd: left.priceUsd + right.priceUsd,
            inputs: [{ path: left }, { path: right }],
            metadata: {},
          }
        },
      },
    ])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path?.priceUsd).toBe(4)
  })

  it('rejects an invalid requested timestamp', async () => {
    const engine = new RecursivePriceEngine(marketFor({}), [])

    await expect(
      engine.resolve({ chainId: 1, token: SHARE, timestamp: -1 }),
    ).rejects.toBeInstanceOf(InvalidPricingError)
  })

  it('runs an unresolvable shared child adapter set exactly once', async () => {
    const childResolve = vi.fn(async () => null)
    const childAdapter: RecursivePriceAdapter = {
      name: 'child-probe',
      async resolve(target) {
        if (target.token.toLowerCase() !== UNDERLYING) {
          return null
        }
        return childResolve()
      },
    }
    const wrap = (name: string, token: string): RecursivePriceAdapter => ({
      name,
      async resolve(target, context) {
        if (target.token.toLowerCase() !== token) {
          return null
        }
        const input = await context.require({ ...target, token: UNDERLYING }, name)
        return { priceUsd: input.priceUsd, inputs: [{ path: input }], metadata: {} }
      },
    })
    const parent: RecursivePriceAdapter = {
      name: 'two-parents',
      async resolve(target, context) {
        if (target.token.toLowerCase() !== SHARE) {
          return null
        }
        const [a, b] = await Promise.all([
          context.require({ ...target, token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'a'),
          context.require({ ...target, token: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'b'),
        ])
        return {
          priceUsd: a.priceUsd + b.priceUsd,
          inputs: [{ path: a }, { path: b }],
          metadata: {},
        }
      },
    }
    const engine = new RecursivePriceEngine(marketFor({}), [
      parent,
      wrap('wrap-a', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      wrap('wrap-b', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      childAdapter,
    ])

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path).toBeNull()
    expect(childResolve).toHaveBeenCalledTimes(1)
  })

  it('aborts with a budget failure once the resolution budget is spent', async () => {
    const probe = vi.fn(async () => null)
    const engine = new RecursivePriceEngine(marketFor({}), [{ name: 'probe', resolve: probe }], 8, new Map(), 1)

    const first = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })
    const second = await engine.resolve({
      chainId: 1,
      token: UNDERLYING,
      timestamp: null,
    })

    expect(first.failure?.reason).toBe('unsupported')
    expect(second.failure?.reason).toBe('budget')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('tries the previously successful adapter first on the next engine', async () => {
    const hints = new Map<string, string>()
    const order: string[] = []
    const miss: RecursivePriceAdapter = {
      name: 'early-miss',
      async resolve() {
        order.push('early-miss')
        return null
      },
    }
    const winner: RecursivePriceAdapter = {
      name: 'late-winner',
      async resolve(target) {
        order.push('late-winner')
        if (target.token.toLowerCase() !== SHARE) {
          return null
        }
        return { priceUsd: 1, inputs: [], metadata: {} }
      },
    }

    const first = new RecursivePriceEngine(marketFor({}), [miss, winner], 8, hints)
    await first.resolve({ chainId: 1, token: SHARE, timestamp: null })
    expect(order).toEqual(['early-miss', 'late-winner'])
    expect([...hints.values()]).toEqual(['late-winner'])

    order.length = 0
    const second = new RecursivePriceEngine(marketFor({}), [miss, winner], 8, hints)
    await second.resolve({ chainId: 1, token: SHARE, timestamp: null })
    expect(order[0]).toBe('late-winner')
    expect(hints.get(`1:${SHARE.toLowerCase()}`)).toBe('late-winner')
  })

  it('replaces a stale adapter hint after a later adapter wins', async () => {
    const hints = new Map<string, string>([[`1:${SHARE.toLowerCase()}`, 'gone']])
    const gone: RecursivePriceAdapter = { name: 'gone', resolve: async () => null }
    const winner: RecursivePriceAdapter = {
      name: 'winner',
      resolve: async () => ({ priceUsd: 1, inputs: [], metadata: {} }),
    }
    const engine = new RecursivePriceEngine(marketFor({}), [gone, winner], 8, hints)

    const result = await engine.resolve({ chainId: 1, token: SHARE, timestamp: null })

    expect(result.path?.adapter).toBe('winner')
    expect(hints.get(`1:${SHARE.toLowerCase()}`)).toBe('winner')
  })
})
