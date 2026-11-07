import { describe, expect, it } from 'vitest'
import { compoundV3WrapperAdapter } from '../../../src/sources/onchain/adapters/compound-v3-wrapper'
import { RecursivePriceEngine } from '../../../src/sources/onchain/engine'
import { RetryablePricingError } from '../../../src/sources/onchain/errors'
import { adapterOptions, BLOCK_TIMESTAMP, fakeClient, marketFor, priceWith } from './helpers'

const wrapper = '0x27f2f159fe990ba83d57f39fd69661764bebf37a'
const comet = '0xc3d688b66703497daa19211eedff47f25384cdc3'
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const reads = () => ({
  [wrapper]: {
    underlyingComet: comet,
    decimals: 6,
    totalSupply: 100_000_000n,
    convertStaticToDynamic: (amount: bigint) => (amount * 6n) / 5n
  },
  [comet]: {
    baseToken: usdc,
    userBasic: [100_000_000n, 0n, 0n, 0, 0],
    isTransferPaused: false,
    isWithdrawPaused: false
  },
  [usdc]: { decimals: 6, balanceOf: 200_000_000n }
})

describe('Reserve static Compound v3 wrapper', () => {
  it('uses principal conversion in base units and the actual USDC price', async () => {
    const result = await priceWith(compoundV3WrapperAdapter(adapterOptions(reads())), { [usdc]: 0.98 }, wrapper)
    expect(result.path?.priceUsd).toBeCloseTo(1.176)
    expect(result.path?.metadata.backingPrincipalRaw).toBe('100000000')
    expect(result.path?.inputs[0].token.toLowerCase()).toBe(usdc)
  })

  it.each(['backing', 'paused', 'liquidity', 'identity'])('refuses invalid %s', async (failure) => {
    const data = reads()
    if (failure === 'backing') data[comet].userBasic[0] = 99_000_000n
    if (failure === 'paused') data[comet].isWithdrawPaused = true
    if (failure === 'liquidity') data[usdc].balanceOf = 0n
    if (failure === 'identity') data[wrapper].underlyingComet = usdc
    const result = await priceWith(compoundV3WrapperAdapter(adapterOptions(data)), { [usdc]: 1 }, wrapper)
    expect(result.path).toBeNull()
    expect(result.failure?.reason).toBe('invalid')
  })

  it('deducts tiny principal rounding from NAV and rejects a material deficit', async () => {
    const data = reads()
    data[wrapper].totalSupply = 5_500_000_000_000n
    data[comet].userBasic[0] = data[wrapper].totalSupply - 76n
    const adapter = compoundV3WrapperAdapter(adapterOptions(data))
    const result = await priceWith(adapter, { [usdc]: 1 }, wrapper)
    expect(result.path?.priceUsd).toBeLessThan(1.2)
    expect(result.path?.priceUsd).toBeGreaterThan(1.199999999)
    expect(result.path?.metadata.principalRoundingShortfallRaw).toBe('76')
    data[comet].userBasic[0] = data[wrapper].totalSupply - 10_000n
    const rejected = await priceWith(compoundV3WrapperAdapter(adapterOptions(data)), { [usdc]: 1 }, wrapper)
    expect(rejected.path).toBeNull()
    expect(rejected.failure?.reason).toBe('invalid')
  })

  it('pins every read to the historical block and propagates transport failure', async () => {
    const client = fakeClient(reads())
    const blocks: unknown[] = []
    const recording = {
      ...client,
      readContract: (args: { blockNumber?: bigint }) => {
        blocks.push(args.blockNumber)
        return client.readContract(args as never)
      }
    } as typeof client
    const result = await new RecursivePriceEngine(marketFor({ [usdc]: 1 }), [
      compoundV3WrapperAdapter({ clientForChain: () => recording })
    ]).resolve({ chainId: 1, token: wrapper, timestamp: BLOCK_TIMESTAMP + 30, blockNumber: 19_000_000 })
    expect(result.path?.priceUsd).toBeCloseTo(1.2)
    expect(new Set(blocks)).toEqual(new Set([19_000_000n]))
    const data = reads()
    const broken = {
      ...data,
      [wrapper]: { ...data[wrapper], convertStaticToDynamic: new RetryablePricingError('RPC down') }
    }
    const failed = await priceWith(compoundV3WrapperAdapter(adapterOptions(broken)), { [usdc]: 1 }, wrapper)
    expect(failed.failure?.reason).toBe('retryable')
  })

  it('requires an independent base price and ignores unreviewed wrappers', async () => {
    const adapter = compoundV3WrapperAdapter(adapterOptions(reads()))
    expect((await priceWith(adapter, {}, wrapper)).path).toBeNull()
    expect((await priceWith(adapter, { [usdc]: 1 }, comet)).path).toBeNull()
  })
})
