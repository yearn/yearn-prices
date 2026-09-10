import { encodeAbiParameters, type PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { curveAdapter } from '../../../src/sources/onchain/adapters/curve'
import { adapterOptions, fakeClient, priceWith } from './helpers'

const LP = '0x1111111111111111111111111111111111111111'
const TOKEN_A = '0x2222222222222222222222222222222222222222'
const CURVE_PROVIDER = '0x0000000022d53366457f9d5e68ec105046fc4383'
const CURVE_POOL = '0x4444444444444444444444444444444444444444'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

const reads = {
  [LP]: { minter: CURVE_POOL, decimals: 18, totalSupply: 100n * 10n ** 18n },
  [CURVE_POOL]: { token: LP, N_COINS: 2n, coins: TOKEN_A, balances: 100n * 10n ** 6n },
  [TOKEN_A]: { decimals: 6 }
}

describe('curveAdapter', () => {
  it('prices an LP token from the pool balances', async () => {
    const result = await priceWith(curveAdapter(adapterOptions(reads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(2)
    expect(result.path?.metadata.coinCountSource).toBe('pool-N_COINS')
  })

  it('discovers all constituents without prices and evaluates captured state without more RPC', async () => {
    const client = fakeClient(reads)
    let calls = 0
    const counting = {
      ...client,
      readContract: (args: never) => {
        calls += 1
        return client.readContract(args)
      }
    } as typeof client
    const adapter = curveAdapter({ clientForChain: () => counting })
    const plan = await adapter.discover({ chainId: 1, token: LP, timestamp: null })
    expect(plan?.dependencies).toHaveLength(2)
    expect(plan?.metadata.totalSupplyRaw).toBe((100n * 10n ** 18n).toString())
    const before = calls
    const inputs = plan!.dependencies.map(({ target }) => ({
      chainId: target.chainId,
      token: target.token,
      requestedTimestamp: target.timestamp,
      observedTimestamp: 100,
      priceUsd: 1,
      symbol: null,
      confidence: null,
      source: 'defillama' as const,
      adapter: 'defillama',
      inputs: [],
      metadata: {}
    }))
    expect(plan!.evaluate(inputs).priceUsd).toBeCloseTo(2)
    expect(plan!.evaluate(inputs).priceUsd).toBeCloseTo(2)
    expect(calls).toBe(before)
  })

  it('prices native pool legs as wrapped native', async () => {
    const nativeReads = {
      ...reads,
      [CURVE_POOL]: {
        token: LP,
        N_COINS: 1n,
        coins: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        balances: 10n * 10n ** 18n
      }
    }

    const result = await priceWith(curveAdapter(adapterOptions(nativeReads)), { [WETH]: 2000 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(200)
  })

  it('falls back to the address provider registry for the pool', async () => {
    const registryReads = {
      [LP]: { decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_PROVIDER]: { get_address: CURVE_POOL },
      [CURVE_POOL]: {
        get_pool_from_lp_token: CURVE_POOL,
        N_COINS: 1n,
        coins: TOKEN_A,
        balances: 100n * 10n ** 6n
      },
      [TOKEN_A]: { decimals: 6 }
    }

    const result = await priceWith(curveAdapter(adapterOptions(registryReads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.priceUsd).toBeCloseTo(1)
  })

  it('reads each address-provider registry once across both registry walks', async () => {
    const registryReads = {
      [LP]: { decimals: 18, totalSupply: 100n * 10n ** 18n },
      [CURVE_PROVIDER]: { get_address: CURVE_POOL },
      [CURVE_POOL]: {
        get_pool_from_lp_token: CURVE_POOL,
        get_n_coins: [1n, 1n],
        coins: TOKEN_A,
        balances: 100n * 10n ** 6n
      },
      [TOKEN_A]: { decimals: 6 }
    }
    const client = fakeClient(registryReads)
    let providerReads = 0
    const counting = {
      ...client,
      readContract: (args: { address: string; functionName: string }) => {
        if (args.functionName === 'get_address') {
          providerReads += 1
        }
        return client.readContract(args as never)
      }
    } as unknown as typeof client

    const result = await priceWith(curveAdapter({ clientForChain: () => counting }), { [TOKEN_A]: 1 }, LP)

    expect(result.path?.metadata.coinCountSource).toBe('curve-registry')
    expect(providerReads).toBe(1)
  })

  it('refuses a token whose minter does not claim it as its LP', async () => {
    const counterfeit = '0x5555555555555555555555555555555555555555'
    const result = await priceWith(
      curveAdapter(
        adapterOptions({
          ...reads,
          [counterfeit]: { minter: CURVE_POOL, decimals: 18, totalSupply: 1n }
        })
      ),
      { [TOKEN_A]: 1 },
      counterfeit
    )

    expect(result.path).toBeNull()
  })

  it('refuses to price when a coin is missing from an authoritative count', async () => {
    const brokenReads = { ...reads, [CURVE_POOL]: { token: LP, N_COINS: 2n, balances: 1n } }

    const result = await priceWith(curveAdapter(adapterOptions(brokenReads)), { [TOKEN_A]: 1 }, LP)

    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('returns no price when no coin count is authoritative', async () => {
    const result = await priceWith(curveAdapter(adapterOptions({ [LP]: { minter: CURVE_POOL, decimals: 18 } })), {}, LP)

    expect(result.path).toBeNull()
  })
})

describe('Curve complete-array discovery', () => {
  const zero = '0x0000000000000000000000000000000000000000'
  function adapter(data: string, failed = false) {
    const base = fakeClient(reads)
    const client = {
      ...base,
      readContract: (args: never) => {
        const { functionName } = args as { functionName: string }
        if (functionName === 'N_COINS') throw new Error('execution reverted')
        if (functionName === 'get_address') return Promise.resolve(CURVE_POOL)
        return base.readContract(args)
      },
      call: async () => {
        if (failed) throw new Error('fetch failed')
        return { data }
      }
    } as PublicClient
    return curveAdapter({ clientForChain: () => client })
  }
  it('reads the entire padded list instead of truncating to two coins', async () => {
    const data = encodeAbiParameters([{ type: 'address[4]' }], [[TOKEN_A, TOKEN_A, TOKEN_A, zero]])
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.path?.metadata.coinCount).toBe(3)
    expect(result.path?.metadata.coinCountSource).toBe('curve-registry-coins')
    expect(result.path?.priceUsd).toBeCloseTo(3)
  })
  it('rejects registry coins that disagree with the pool', async () => {
    const data = encodeAbiParameters([{ type: 'address[2]' }], [[TOKEN_A, LP]])
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.failure?.reason).toBe('invalid')
  })
  it.each([
    encodeAbiParameters([{ type: 'address[]' }], [[TOKEN_A, TOKEN_A]]),
    encodeAbiParameters([{ type: 'address[4]' }], [[TOKEN_A, zero, TOKEN_A, zero]]),
    encodeAbiParameters([{ type: 'address[2]' }], [[zero, zero]]),
    '0x1234'
  ])('rejects ambiguous or malformed lists: %s', async (data) => {
    const result = await priceWith(adapter(data), { [TOKEN_A]: 1 }, LP)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('unsupported')
  })
  it('keeps failed whole-array reads retryable', async () => {
    const result = await priceWith(adapter('0x', true), { [TOKEN_A]: 1 }, LP)
    expect(result.failure?.reason).toBe('retryable')
  })
})
