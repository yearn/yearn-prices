import { parseAbi, type Address, type PublicClient } from 'viem'
import { chainNameToId, normalizeTokenAddress } from './chains'
import { estimateBlockByTimestamp } from './rpc'
import {
  calculateCompoundTokenPrice,
  calculatePoolNavPrice,
  calculateWrapperPrice,
  InvalidPricingError,
  isRetryablePricingError,
  RetryablePricingError,
  scaledRaw,
  type RecursivePriceAdapter,
  type RecursivePriceContext,
  type RecursivePriceInput,
  type RecursivePriceTarget,
  type ResolvedPricePath,
} from './recursive-pricing'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const CURVE_ADDRESS_PROVIDER = '0x0000000022D53366457F9d5E68Ec105046FC4383' as Address
const CURVE_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const PENDLE_ORACLE = '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2' as Address
const YIP88_LIQUID_LOCKER_REDEMPTION = '0xba18d0df75a3ff58ef40a8fc0d3e4db74a0e681d' as Address
const YIP88_LIQUID_LOCKERS = new Map<string, bigint>([
  ['0x95710bde45c8d384a976cc58cc7a7e489576b098', 1n],
  ['0xff71841eefca78a64421db28060855036765c248', 2n],
])

const WRAPPED_NATIVE: Record<number, string> = {
  1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  10: '0x4200000000000000000000000000000000000006',
  100: '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d',
  137: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  250: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83',
  8453: '0x4200000000000000000000000000000000000006',
  42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
}

const CANONICAL_BALANCER_VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8'
const BALANCER_VAULTS: Record<number, string> = {
  1: CANONICAL_BALANCER_VAULT,
  10: CANONICAL_BALANCER_VAULT,
  100: CANONICAL_BALANCER_VAULT,
  137: CANONICAL_BALANCER_VAULT,
  250: '0x20dd72ed959b6147912c2e529f0a0c651c33c9ce',
  42161: CANONICAL_BALANCER_VAULT,
}

const BEETS_BAR_WRAPPERS: Record<number, ReadonlySet<string>> = {
  250: new Set(['0xfcef8a994209d6916eb2c86cdd2afd60aa6f54b1']),
}

const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])
const beetsBarAbi = parseAbi(['function vestingToken() view returns (address)'])
const erc4626Abi = parseAbi([
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function maxDeposit(address receiver) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
])
const liquidLockerRedemptionAbi = parseAbi([
  'function yfi() view returns (address)',
  'function fee() view returns (uint256)',
  'function tokens(uint256 index) view returns (address)',
  'function scales(uint256 index) view returns (uint256)',
  'function capacities(uint256 index) view returns (uint256)',
  'function enabled(uint256 index) view returns (bool)',
  'function used(uint256 index) view returns (uint256)',
])
const yearnUnderlyingAbis = [
  parseAbi(['function token() view returns (address)']),
  parseAbi(['function underlying() view returns (address)']),
  parseAbi(['function want() view returns (address)']),
] as const
const yearnRateAbis = [
  { name: 'pricePerShare', abi: parseAbi(['function pricePerShare() view returns (uint256)']) },
  { name: 'getPricePerShare', abi: parseAbi(['function getPricePerShare() view returns (uint256)']) },
  { name: 'getPricePerFullShare', abi: parseAbi(['function getPricePerFullShare() view returns (uint256)']) },
] as const
const compoundAbi = parseAbi([
  'function underlying() view returns (address)',
  'function exchangeRateStored() view returns (uint256)',
])
const aaveAbi = parseAbi(['function UNDERLYING_ASSET_ADDRESS() view returns (address)'])
const wstEthAbi = parseAbi([
  'function stETH() view returns (address)',
  'function stEthPerToken() view returns (uint256)',
])
const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
])
const curveMinterAbi = parseAbi(['function minter() view returns (address)'])
const curveProviderAbi = parseAbi(['function get_address(uint256) view returns (address)'])
const curveRegistryAbi = parseAbi(['function get_pool_from_lp_token(address) view returns (address)'])
const curveCoinUintAbi = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
])
const curveCoinIntAbi = parseAbi([
  'function coins(int128) view returns (address)',
  'function balances(int128) view returns (uint256)',
])
const balancerPoolAbi = parseAbi(['function getPoolId() view returns (bytes32)'])
const balancerVaultAbi = parseAbi([
  'function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)',
])
const pendleMarketAbi = parseAbi(['function readTokens() view returns (address sy, address pt, address yt)'])
const pendleSyAbi = parseAbi([
  'function assetInfo() view returns (uint8 assetType, address asset, uint8 assetDecimals)',
])
const pendleOracleAbi = parseAbi([
  'function getLpToAssetRate(address market, uint32 duration) view returns (uint256)',
])

interface CurveCoin {
  address: string
  onchainAddress: string
  decimals: number
  balanceRaw: bigint
}

export type ClientForChain = (chainId: number) => PublicClient | null
export type BlockForTarget = (
  client: PublicClient,
  chainId: number,
  target: RecursivePriceTarget,
) => Promise<bigint>
export type BlockTimestampForTarget = (
  client: PublicClient,
  blockNumber: bigint,
  target: RecursivePriceTarget,
) => Promise<number>

export interface OnchainAdapterOptions {
  clientForChain: ClientForChain
  blockForTarget?: BlockForTarget
  blockTimestampForTarget?: BlockTimestampForTarget
  pendleTwapSeconds?: number
}

interface HistoricalContractContext {
  client: PublicClient
  chainId: number
  blockNumber: bigint
  numericBlockNumber: number
  blockTimestamp: number
  address: Address
}

async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isRetryablePricingError(error)) {
      throw new RetryablePricingError(error instanceof Error ? error.message : String(error), { cause: error })
    }
    return null
  }
}

function normalizedAddress(address: string): `0x${string}` | null {
  if (address.toLowerCase() === ZERO_ADDRESS) return null
  return normalizeTokenAddress(address)
}

async function defaultBlockForTarget(
  client: PublicClient,
  chainId: number,
  target: RecursivePriceTarget,
): Promise<bigint> {
  return target.blockNumber == null
    ? estimateBlockByTimestamp(client, chainId, target.requestedTimestamp)
    : BigInt(target.blockNumber)
}

async function contractContext(
  target: RecursivePriceTarget,
  options: OnchainAdapterOptions,
): Promise<HistoricalContractContext> {
  const chainId = chainNameToId(target.chain)
  if (chainId == null) throw new Error(`Unsupported chain: ${target.chain}`)
  const client = options.clientForChain(chainId)
  if (!client) {
    throw new RetryablePricingError(`RPC_URL_${chainId} is not configured; on-chain pricing is temporarily unavailable`)
  }
  const blockNumber = await (options.blockForTarget ?? defaultBlockForTarget)(client, chainId, target)
  const numericBlockNumber = Number(blockNumber)
  if (!Number.isSafeInteger(numericBlockNumber) || numericBlockNumber < 0) {
    throw new Error(`Historical block ${blockNumber} is outside the supported numeric range`)
  }
  const blockTimestamp = options.blockTimestampForTarget
    ? await options.blockTimestampForTarget(client, blockNumber, target)
    : options.blockForTarget
      ? target.requestedTimestamp
      : Number((await client.getBlock({ blockNumber })).timestamp)
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) {
    throw new InvalidPricingError('Historical block has an invalid timestamp')
  }
  if (blockTimestamp > target.requestedTimestamp) {
    throw new InvalidPricingError('Historical block is after the requested EOD timestamp')
  }
  return {
    client,
    chainId,
    blockNumber,
    numericBlockNumber,
    blockTimestamp,
    address: target.token as Address,
  }
}

function historicalBlockEvidence(
  state: HistoricalContractContext,
  target: RecursivePriceTarget,
): Record<string, unknown> {
  return {
    historicalBlock: {
      number: state.numericBlockNumber,
      timestamp: state.blockTimestamp,
      requestedTimestamp: target.requestedTimestamp,
      distanceSeconds: target.requestedTimestamp - state.blockTimestamp,
    },
  }
}

function childTarget(
  parent: RecursivePriceTarget,
  token: string,
  blockNumber: number,
): RecursivePriceTarget {
  return { ...parent, token: normalizeTokenAddress(token), blockNumber }
}

function rawState(value: bigint): string {
  return value.toString()
}

async function tokenDecimals(client: PublicClient, address: string, blockNumber: bigint): Promise<number> {
  return Number(await client.readContract({
    address: address as Address,
    abi: erc20Abi,
    functionName: 'decimals',
    blockNumber,
  }))
}

function recursiveInput(path: ResolvedPricePath, conversion: Record<string, unknown>): RecursivePriceInput {
  return { path, conversion }
}

function yip88LiquidLockerAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'yip88-liquid-locker-redemption',
    async resolve(target, context) {
      if (target.chain !== 'ethereum') return null
      const index = YIP88_LIQUID_LOCKERS.get(target.token.toLowerCase())
      if (index == null) return null

      const state = await contractContext(target, options)
      const [
        yfiRaw,
        feeRaw,
        facilityTokenRaw,
        scaleRaw,
        capacityRaw,
        enabled,
        usedRaw,
        targetDecimalsRaw,
      ] = await Promise.all([
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'yfi', blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'fee', blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'tokens', args: [index], blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'scales', args: [index], blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'capacities', args: [index], blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'enabled', args: [index], blockNumber: state.blockNumber }),
        state.client.readContract({ address: YIP88_LIQUID_LOCKER_REDEMPTION, abi: liquidLockerRedemptionAbi, functionName: 'used', args: [index], blockNumber: state.blockNumber }),
        state.client.readContract({ address: state.address, abi: erc20Abi, functionName: 'decimals', blockNumber: state.blockNumber }),
      ])
      const yfi = normalizedAddress(yfiRaw)
      const facilityToken = normalizedAddress(facilityTokenRaw)
      if (!yfi || !facilityToken || !enabled || feeRaw >= 10n ** 18n || scaleRaw === 0n || usedRaw > capacityRaw) return null

      const targetDecimals = Number(targetDecimalsRaw)
      const oneTargetRaw = 10n ** BigInt(targetDecimals)
      let facilityTokenAmountRaw = oneTargetRaw
      let wrapper: Record<string, unknown> | null = null
      if (facilityToken.toLowerCase() !== target.token.toLowerCase()) {
        const [assetRaw, maxDepositRaw, convertedSharesRaw] = await Promise.all([
          state.client.readContract({ address: facilityToken, abi: erc4626Abi, functionName: 'asset', blockNumber: state.blockNumber }),
          state.client.readContract({ address: facilityToken, abi: erc4626Abi, functionName: 'maxDeposit', args: [YIP88_LIQUID_LOCKER_REDEMPTION], blockNumber: state.blockNumber }),
          state.client.readContract({ address: facilityToken, abi: erc4626Abi, functionName: 'convertToShares', args: [oneTargetRaw], blockNumber: state.blockNumber }),
        ])
        const asset = normalizedAddress(assetRaw)
        if (!asset || asset.toLowerCase() !== target.token.toLowerCase() || maxDepositRaw < oneTargetRaw || convertedSharesRaw === 0n) return null
        facilityTokenAmountRaw = convertedSharesRaw
        wrapper = {
          address: facilityToken,
          asset,
          maxDepositRaw: rawState(maxDepositRaw),
          convertedSharesRaw: rawState(convertedSharesRaw),
        }
      }

      const grossYfiRaw = facilityTokenAmountRaw / scaleRaw
      const remainingCapacityRaw = capacityRaw - usedRaw
      const netYfiRaw = grossYfiRaw * (10n ** 18n - feeRaw) / 10n ** 18n
      if (grossYfiRaw === 0n || grossYfiRaw > remainingCapacityRaw || netYfiRaw === 0n) return null

      const [yfiDecimals, yfiLiquidityRaw] = await Promise.all([
        tokenDecimals(state.client, yfi, state.blockNumber),
        state.client.readContract({
          address: yfi,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [YIP88_LIQUID_LOCKER_REDEMPTION],
          blockNumber: state.blockNumber,
        }),
      ])
      if (yfiLiquidityRaw < netYfiRaw) return null

      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: 'yip88-net-redemption',
        valuationRule: 'enabled-capacity-and-liquidity-checked-net-redemption',
        facility: YIP88_LIQUID_LOCKER_REDEMPTION,
        index: index.toString(),
        facilityToken,
        wrapper,
        yfi,
        targetDecimals,
        yfiDecimals,
        oneTargetRaw: rawState(oneTargetRaw),
        facilityTokenAmountRaw: rawState(facilityTokenAmountRaw),
        scaleRaw: rawState(scaleRaw),
        feeRaw: rawState(feeRaw),
        grossYfiRaw: rawState(grossYfiRaw),
        netYfiRaw: rawState(netYfiRaw),
        capacityRaw: rawState(capacityRaw),
        usedRaw: rawState(usedRaw),
        remainingCapacityRaw: rawState(remainingCapacityRaw),
        yfiLiquidityRaw: rawState(yfiLiquidityRaw),
        references: [
          'https://docs.yearn.fi/contributing/governance/yips/yip-88',
          'https://github.com/yearn/stYFI/blob/master/contracts/LiquidLockerRedemption.vy',
          'https://github.com/yearn/stYFI/blob/master/deployment.json',
        ],
      }
      const input = await context.require(
        childTarget(target, yfi, state.numericBlockNumber),
        'YIP-88 redemption YFI',
      )
      return {
        priceUsd: calculateWrapperPrice(netYfiRaw, yfiDecimals, oneTargetRaw, targetDecimals, input.priceUsd),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function erc4626Adapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'erc4626-convert-to-assets',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [underlyingRaw, shareDecimalsRaw] = await Promise.all([
        maybe(() => state.client.readContract({
          address: state.address,
          abi: erc4626Abi,
          functionName: 'asset',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber: state.blockNumber,
        })),
      ])
      if (!underlyingRaw || shareDecimalsRaw == null) return null
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null

      const shareDecimals = Number(shareDecimalsRaw)
      const oneShareRaw = 10n ** BigInt(shareDecimals)
      let method = 'convertToAssets'
      let convertedAssetsRaw = await maybe(() => state.client.readContract({
        address: state.address,
        abi: erc4626Abi,
        functionName: 'convertToAssets',
        args: [oneShareRaw],
        blockNumber: state.blockNumber,
      }))
      if (convertedAssetsRaw == null) {
        method = 'previewRedeem'
        convertedAssetsRaw = await maybe(() => state.client.readContract({
          address: state.address,
          abi: erc4626Abi,
          functionName: 'previewRedeem',
          args: [oneShareRaw],
          blockNumber: state.blockNumber,
        }))
      }
      if (convertedAssetsRaw == null) return null
      const underlyingDecimals = await tokenDecimals(state.client, underlying, state.blockNumber)
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method,
        underlying,
        shareDecimals,
        underlyingDecimals,
        oneShareRaw: rawState(oneShareRaw),
        convertedAssetsRaw: rawState(convertedAssetsRaw),
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'ERC-4626 underlying',
      )
      return {
        priceUsd: calculateWrapperPrice(
          convertedAssetsRaw,
          underlyingDecimals,
          oneShareRaw,
          shareDecimals,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function beetsBarAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'beets-bar-share-rate',
    async resolve(target, context) {
      const chainId = chainNameToId(target.chain)
      if (chainId == null || !BEETS_BAR_WRAPPERS[chainId]?.has(target.token.toLowerCase())) return null

      const state = await contractContext(target, options)
      const underlyingRaw = await state.client.readContract({
        address: state.address,
        abi: beetsBarAbi,
        functionName: 'vestingToken',
        blockNumber: state.blockNumber,
      })
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null

      const [shareDecimals, underlyingDecimals, totalSupplyRaw, underlyingBalanceRaw] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        tokenDecimals(state.client, underlying, state.blockNumber),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        }),
        state.client.readContract({
          address: underlying,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [state.address],
          blockNumber: state.blockNumber,
        }),
      ])
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: 'beets-bar-pro-rata-underlying',
        underlying,
        shareDecimals,
        underlyingDecimals,
        totalSupplyRaw: rawState(totalSupplyRaw),
        underlyingBalanceRaw: rawState(underlyingBalanceRaw),
        valuationRule: 'all-underlying-bpt-constituents-required',
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'BeetsBar underlying BPT',
      )
      return {
        priceUsd: calculateWrapperPrice(
          underlyingBalanceRaw,
          underlyingDecimals,
          totalSupplyRaw,
          shareDecimals,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function yearnShareAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'yearn-share-rate',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      let underlying: `0x${string}` | null = null
      for (const abi of yearnUnderlyingAbis) {
        const candidate = await maybe(() => state.client.readContract({
          address: state.address,
          abi,
          functionName: abi[0].name,
          blockNumber: state.blockNumber,
        }))
        if (typeof candidate === 'string') {
          underlying = normalizedAddress(candidate)
          if (underlying) break
        }
      }
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null

      let rate: { method: string; raw: bigint } | null = null
      for (const candidate of yearnRateAbis) {
        const raw = await maybe(() => state.client.readContract({
          address: state.address,
          abi: candidate.abi,
          functionName: candidate.name,
          blockNumber: state.blockNumber,
        }))
        if (typeof raw === 'bigint') {
          rate = { method: candidate.name, raw }
          break
        }
      }
      if (!rate) return null

      const [shareDecimals, underlyingDecimals] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        tokenDecimals(state.client, underlying, state.blockNumber),
      ])
      const rateDecimals = rate.method === 'getPricePerFullShare' ? 18 : underlyingDecimals
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: rate.method,
        underlying,
        rateRaw: rawState(rate.raw),
        rateDecimals,
        shareDecimals,
        underlyingDecimals,
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'Yearn share underlying',
      )
      return {
        priceUsd: calculateWrapperPrice(
          rate.raw,
          rateDecimals,
          10n ** BigInt(shareDecimals),
          shareDecimals,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function compoundAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'compound-exchange-rate',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [underlyingRaw, exchangeRateRaw] = await Promise.all([
        maybe(() => state.client.readContract({
          address: state.address,
          abi: compoundAbi,
          functionName: 'underlying',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: compoundAbi,
          functionName: 'exchangeRateStored',
          blockNumber: state.blockNumber,
        })),
      ])
      if (!underlyingRaw || exchangeRateRaw == null) return null
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null

      const [shareDecimals, underlyingDecimals] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        tokenDecimals(state.client, underlying, state.blockNumber),
      ])
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: 'exchangeRateStored',
        underlying,
        exchangeRateRaw: rawState(exchangeRateRaw),
        shareDecimals,
        underlyingDecimals,
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'Compound underlying',
      )
      return {
        priceUsd: calculateCompoundTokenPrice(
          exchangeRateRaw,
          shareDecimals,
          underlyingDecimals,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function aaveAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'aave-underlying-parity',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const underlyingRaw = await maybe(() => state.client.readContract({
        address: state.address,
        abi: aaveAbi,
        functionName: 'UNDERLYING_ASSET_ADDRESS',
        blockNumber: state.blockNumber,
      }))
      if (!underlyingRaw) return null
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null
      const conversion = { ...historicalBlockEvidence(state, target), method: 'one-to-one', underlying }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'Aave underlying',
      )
      return {
        priceUsd: input.priceUsd,
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function wstEthAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'wsteth-rate',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [underlyingRaw, rateRaw] = await Promise.all([
        maybe(() => state.client.readContract({
          address: state.address,
          abi: wstEthAbi,
          functionName: 'stETH',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: wstEthAbi,
          functionName: 'stEthPerToken',
          blockNumber: state.blockNumber,
        })),
      ])
      if (!underlyingRaw || rateRaw == null) return null
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) return null
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: 'stEthPerToken',
        underlying,
        rateRaw: rawState(rateRaw),
        rateDecimals: 18,
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'wstETH underlying',
      )
      return {
        priceUsd: calculateWrapperPrice(rateRaw, 18, 10n ** 18n, 18, input.priceUsd),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

function pairAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'amm-reserve-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [token0Raw, token1Raw, reserves, totalSupplyRaw, poolDecimalsRaw] = await Promise.all([
        maybe(() => state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'token0',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'token1',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'getReserves',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        })),
        maybe(() => state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber: state.blockNumber,
        })),
      ])
      if (!token0Raw || !token1Raw || !reserves || totalSupplyRaw == null || poolDecimalsRaw == null) {
        return null
      }
      const token0 = normalizedAddress(token0Raw)
      const token1 = normalizedAddress(token1Raw)
      if (!token0 || !token1) return null

      const [token0Decimals, token1Decimals, resolutions] = await Promise.all([
        tokenDecimals(state.client, token0, state.blockNumber),
        tokenDecimals(state.client, token1, state.blockNumber),
        Promise.all([
          context.resolve(childTarget(target, token0, state.numericBlockNumber)),
          context.resolve(childTarget(target, token1, state.numericBlockNumber)),
        ]),
      ])
      const paths: Array<ResolvedPricePath | null> = resolutions.map(resolution => resolution.path)
      const blockingFailure = resolutions.find(resolution => (
        resolution.failure && resolution.failure.reason !== 'unsupported'
      ))?.failure
      if (blockingFailure?.reason === 'retryable') {
        throw new RetryablePricingError(`AMM constituent failed transiently: ${JSON.stringify(blockingFailure)}`)
      }
      if (blockingFailure) {
        throw new InvalidPricingError(`AMM constituent is not safely substitutable: ${JSON.stringify(blockingFailure)}`)
      }
      if (!paths[0] || !paths[1]) {
        const unavailableConstituents = [
          { address: token0, resolution: resolutions[0] },
          { address: token1, resolution: resolutions[1] },
        ].flatMap(({ address, resolution }) => (
          resolution.path
            ? []
            : [{ address, failureClass: resolution.failure?.reason ?? 'unavailable' }]
        ))
        throw new InvalidPricingError(
          `AMM reserve NAV requires every constituent price: ${JSON.stringify(unavailableConstituents)}`,
        )
      }

      const decimals = [token0Decimals, token1Decimals]
      const balances = [reserves[0], reserves[1]]
      const inputs = paths as [ResolvedPricePath, ResolvedPricePath]
      const poolDecimals = Number(poolDecimalsRaw)
      const metadata = {
        ...historicalBlockEvidence(state, target),
        valuationRule: 'all-constituents-required',
        totalSupplyRaw: rawState(totalSupplyRaw),
        poolDecimals,
        reserves: [
          { address: token0, decimals: token0Decimals, balanceRaw: rawState(reserves[0]) },
          { address: token1, decimals: token1Decimals, balanceRaw: rawState(reserves[1]) },
        ],
      }
      return {
        priceUsd: calculatePoolNavPrice(
          [
            { address: token0, balanceRaw: reserves[0], decimals: token0Decimals, priceUsd: inputs[0].priceUsd },
            { address: token1, balanceRaw: reserves[1], decimals: token1Decimals, priceUsd: inputs[1].priceUsd },
          ],
          totalSupplyRaw,
          poolDecimals,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) => recursiveInput(path, {
          method: 'pool-reserve-nav',
          balanceRaw: rawState(balances[index]),
          decimals: decimals[index],
        })),
        metadata,
      }
    },
  }
}

async function curvePoolFromRegistry(
  client: PublicClient,
  lpToken: Address,
  blockNumber: bigint,
): Promise<string | null> {
  for (let registryId = 0; registryId <= 12; registryId += 1) {
    const registryRaw = await maybe(() => client.readContract({
      address: CURVE_ADDRESS_PROVIDER,
      abi: curveProviderAbi,
      functionName: 'get_address',
      args: [BigInt(registryId)],
      blockNumber,
    }))
    if (!registryRaw) continue
    const registry = normalizedAddress(registryRaw)
    if (!registry) continue
    const poolRaw = await maybe(() => client.readContract({
      address: registry,
      abi: curveRegistryAbi,
      functionName: 'get_pool_from_lp_token',
      args: [lpToken],
      blockNumber,
    }))
    if (!poolRaw) continue
    const pool = normalizedAddress(poolRaw)
    if (pool) return pool
  }
  return null
}

async function readCurveCoinAddress(
  client: PublicClient,
  poolAddress: Address,
  index: number,
  blockNumber: bigint,
): Promise<{ address: string; indexType: 'uint256' | 'int128' } | null> {
  const uintAddress = await maybe(() => client.readContract({
    address: poolAddress,
    abi: curveCoinUintAbi,
    functionName: 'coins',
    args: [BigInt(index)],
    blockNumber,
  }))
  if (uintAddress) {
    const address = normalizedAddress(uintAddress)
    if (address) return { address, indexType: 'uint256' }
  }
  const intAddress = await maybe(() => client.readContract({
    address: poolAddress,
    abi: curveCoinIntAbi,
    functionName: 'coins',
    args: [BigInt(index)],
    blockNumber,
  }))
  if (!intAddress) return null
  const address = normalizedAddress(intAddress)
  return address ? { address, indexType: 'int128' } : null
}

async function resolveCurvePool(
  target: RecursivePriceTarget,
  state: HistoricalContractContext,
): Promise<string | null> {
  const minterRaw = await maybe(() => state.client.readContract({
    address: state.address,
    abi: curveMinterAbi,
    functionName: 'minter',
    blockNumber: state.blockNumber,
  }))
  if (minterRaw) {
    const minter = normalizedAddress(minterRaw)
    if (minter) return minter
  }
  if (await readCurveCoinAddress(state.client, state.address, 0, state.blockNumber)) return target.token
  return curvePoolFromRegistry(state.client, state.address, state.blockNumber)
}

function curveAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'curve-reserve-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const poolAddress = await resolveCurvePool(target, state)
      if (!poolAddress) return null
      const coins: CurveCoin[] = []
      for (let index = 0; index < 8; index += 1) {
        const coin = await readCurveCoinAddress(
          state.client,
          poolAddress as Address,
          index,
          state.blockNumber,
        )
        if (!coin) break
        const pricingAddress = coin.address.toLowerCase() === CURVE_NATIVE_TOKEN
          ? WRAPPED_NATIVE[state.chainId]
          : coin.address
        if (!pricingAddress) {
          throw new Error(`No wrapped native asset is configured for Curve on chain ${state.chainId}`)
        }
        const decimals = coin.address.toLowerCase() === CURVE_NATIVE_TOKEN
          ? 18
          : await tokenDecimals(state.client, coin.address, state.blockNumber)
        const balanceRaw = await state.client.readContract({
          address: poolAddress as Address,
          abi: coin.indexType === 'uint256' ? curveCoinUintAbi : curveCoinIntAbi,
          functionName: 'balances',
          args: [BigInt(index)],
          blockNumber: state.blockNumber,
        })
        coins.push({ address: pricingAddress, onchainAddress: coin.address, decimals, balanceRaw })
      }
      if (coins.length === 0) return null

      const [poolDecimals, totalSupplyRaw, inputs] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        }),
        requireChildren(
          context,
          target,
          coins.map(coin => coin.address),
          state.numericBlockNumber,
          'Curve constituent',
        ),
      ])
      const metadata = {
        ...historicalBlockEvidence(state, target),
        poolAddress,
        valuationRule: 'all-constituents-required',
        totalSupplyRaw: rawState(totalSupplyRaw),
        poolDecimals,
        coins: coins.map(coin => ({
          address: coin.address,
          onchainAddress: coin.onchainAddress,
          decimals: coin.decimals,
          balanceRaw: rawState(coin.balanceRaw),
        })),
      }
      return {
        priceUsd: calculatePoolNavPrice(
          coins.map((coin, index) => ({ ...coin, priceUsd: inputs[index].priceUsd })),
          totalSupplyRaw,
          poolDecimals,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) => recursiveInput(path, {
          method: 'curve-reserve-nav',
          balanceRaw: rawState(coins[index].balanceRaw),
          decimals: coins[index].decimals,
        })),
        metadata,
      }
    },
  }
}

function balancerAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'balancer-v2-vault-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const vaultAddress = BALANCER_VAULTS[state.chainId]
      if (!vaultAddress) return null
      const poolId = await maybe(() => state.client.readContract({
        address: state.address,
        abi: balancerPoolAbi,
        functionName: 'getPoolId',
        blockNumber: state.blockNumber,
      }))
      if (!poolId) return null

      const [poolTokens, poolDecimals, totalSupplyRaw] = await Promise.all([
        state.client.readContract({
          address: vaultAddress as Address,
          abi: balancerVaultAbi,
          functionName: 'getPoolTokens',
          args: [poolId],
          blockNumber: state.blockNumber,
        }),
        tokenDecimals(state.client, target.token, state.blockNumber),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        }),
      ])
      const targetAddress = target.token.toLowerCase()
      const assets = poolTokens[0].map((address, index) => ({
        address: normalizeTokenAddress(address),
        balanceRaw: poolTokens[1][index],
      }))
      const selfAsset = assets.find(asset => asset.address.toLowerCase() === targetAddress)
      const constituents = assets.filter(asset => asset.address.toLowerCase() !== targetAddress)
      const [decimals, inputs] = await Promise.all([
        Promise.all(constituents.map(asset => tokenDecimals(state.client, asset.address, state.blockNumber))),
        requireChildren(
          context,
          target,
          constituents.map(asset => asset.address),
          state.numericBlockNumber,
          'Balancer constituent',
        ),
      ])
      const selfBalanceRaw = selfAsset?.balanceRaw ?? 0n
      const metadata = {
        ...historicalBlockEvidence(state, target),
        vaultAddress,
        poolId,
        valuationRule: 'all-constituents-required',
        totalSupplyRaw: rawState(totalSupplyRaw),
        excludedPremintedPoolTokensRaw: rawState(selfBalanceRaw),
        poolDecimals,
        lastChangeBlock: poolTokens[2].toString(),
        tokens: constituents.map((asset, index) => ({
          address: asset.address,
          decimals: decimals[index],
          balanceRaw: rawState(asset.balanceRaw),
        })),
      }
      return {
        priceUsd: calculatePoolNavPrice(
          constituents.map((asset, index) => ({
            ...asset,
            decimals: decimals[index],
            priceUsd: inputs[index].priceUsd,
          })),
          totalSupplyRaw,
          poolDecimals,
          selfBalanceRaw,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) => recursiveInput(path, {
          method: 'balancer-vault-nav',
          balanceRaw: rawState(constituents[index].balanceRaw),
          decimals: decimals[index],
        })),
        metadata,
      }
    },
  }
}

function pendleAdapter(options: OnchainAdapterOptions, twapSeconds: number): RecursivePriceAdapter {
  return {
    name: 'pendle-oracle-lp-to-asset',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const tokens = await maybe(() => state.client.readContract({
        address: state.address,
        abi: pendleMarketAbi,
        functionName: 'readTokens',
        blockNumber: state.blockNumber,
      }))
      if (!tokens) return null
      const assetInfo = await maybe(() => state.client.readContract({
        address: tokens[0],
        abi: pendleSyAbi,
        functionName: 'assetInfo',
        blockNumber: state.blockNumber,
      }))
      if (!assetInfo) return null
      const asset = normalizedAddress(assetInfo[1])
      if (!asset || asset.toLowerCase() === target.token.toLowerCase()) return null
      const rateRaw = await state.client.readContract({
        address: PENDLE_ORACLE,
        abi: pendleOracleAbi,
        functionName: 'getLpToAssetRate',
        args: [state.address, twapSeconds],
        blockNumber: state.blockNumber,
      })
      const assetDecimals = Number(assetInfo[2])
      const conversion = {
        ...historicalBlockEvidence(state, target),
        method: 'getLpToAssetRate',
        oracleAddress: PENDLE_ORACLE,
        twapSeconds,
        syToken: tokens[0],
        ptToken: tokens[1],
        ytToken: tokens[2],
        asset,
        assetType: Number(assetInfo[0]),
        assetDecimals,
        rateDecimals: 18,
        lpToAssetRateRaw: rawState(rateRaw),
      }
      const input = await context.require(
        childTarget(target, asset, state.numericBlockNumber),
        'Pendle SY asset',
      )
      return {
        priceUsd: calculateWrapperPrice(
          rateRaw,
          18,
          10n ** 18n,
          18,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}

export function createOnchainPriceAdapters(options: OnchainAdapterOptions): RecursivePriceAdapter[] {
  const twapSeconds = options.pendleTwapSeconds ?? 900
  if (!Number.isInteger(twapSeconds) || twapSeconds < 1 || twapSeconds > 4_294_967_295) {
    throw new Error('Pendle TWAP seconds must fit uint32 and be positive')
  }
  return [
    yip88LiquidLockerAdapter(options),
    beetsBarAdapter(options),
    erc4626Adapter(options),
    yearnShareAdapter(options),
    compoundAdapter(options),
    aaveAdapter(options),
    wstEthAdapter(options),
    pairAdapter(options),
    balancerAdapter(options),
    pendleAdapter(options, twapSeconds),
    curveAdapter(options),
  ]
}

export async function requireChildren(
  context: RecursivePriceContext,
  parent: RecursivePriceTarget,
  addresses: string[],
  blockNumber: number,
  label: string,
): Promise<ResolvedPricePath[]> {
  return Promise.all(addresses.map(address => (
    context.require(childTarget(parent, address, blockNumber), label)
  )))
}
