import { parseAbi, type Address } from 'viem'
import { erc4626Abi } from '../abis'
import {
  blockEvidence,
  childTarget,
  contractContext,
  erc20Abi,
  normalizedAddress,
  rawState,
  recursiveInput,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculateWrapperPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const REDEMPTION_FACILITY = '0xba18d0df75a3ff58ef40a8fc0d3e4db74a0e681d' as Address
const LIQUID_LOCKERS = new Map<string, bigint>([
  ['0x95710bde45c8d384a976cc58cc7a7e489576b098', 1n],
  ['0xff71841eefca78a64421db28060855036765c248', 2n],
])
const WAD = 10n ** 18n

const facilityAbi = parseAbi([
  'function yfi() view returns (address)',
  'function fee() view returns (uint256)',
  'function tokens(uint256 index) view returns (address)',
  'function scales(uint256 index) view returns (uint256)',
  'function capacities(uint256 index) view returns (uint256)',
  'function enabled(uint256 index) view returns (bool)',
  'function used(uint256 index) view returns (uint256)',
])

/**
 * Prices a YIP-88 liquid locker at what the redemption facility actually pays
 * in YFI, net of fee. It prices only when redemption would succeed: the index
 * is enabled, inside its remaining capacity, and covered by the facility's YFI
 * balance.
 */
export function yip88LiquidLockerAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'yip88-liquid-locker-redemption',
    async resolve(target, context) {
      if (target.chainId !== 1) {
        return null
      }
      const index = LIQUID_LOCKERS.get(target.token.toLowerCase())
      if (index == null) {
        return null
      }

      const state = await contractContext(target, options)
      const facility = {
        address: REDEMPTION_FACILITY,
        abi: facilityAbi,
        blockNumber: state.blockNumber,
      } as const
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
        state.client.readContract({ ...facility, functionName: 'yfi' }),
        state.client.readContract({ ...facility, functionName: 'fee' }),
        state.client.readContract({ ...facility, functionName: 'tokens', args: [index] }),
        state.client.readContract({ ...facility, functionName: 'scales', args: [index] }),
        state.client.readContract({ ...facility, functionName: 'capacities', args: [index] }),
        state.client.readContract({ ...facility, functionName: 'enabled', args: [index] }),
        state.client.readContract({ ...facility, functionName: 'used', args: [index] }),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber: state.blockNumber,
        }),
      ])
      const yfi = normalizedAddress(yfiRaw)
      const facilityToken = normalizedAddress(facilityTokenRaw)
      if (
        !yfi ||
        !facilityToken ||
        !enabled ||
        feeRaw >= WAD ||
        scaleRaw === 0n ||
        usedRaw > capacityRaw
      ) {
        return null
      }

      const targetDecimals = Number(targetDecimalsRaw)
      const oneTargetRaw = 10n ** BigInt(targetDecimals)
      let facilityTokenAmountRaw = oneTargetRaw
      let wrapper: Record<string, unknown> | null = null
      if (facilityToken.toLowerCase() !== target.token.toLowerCase()) {
        // The facility accepts a wrapper of the locker; convert one locker
        // token into wrapper shares before applying the redemption scale.
        const [assetRaw, maxDepositRaw, convertedSharesRaw] = await Promise.all([
          state.client.readContract({
            address: facilityToken,
            abi: erc4626Abi,
            functionName: 'asset',
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: facilityToken,
            abi: erc4626Abi,
            functionName: 'maxDeposit',
            args: [REDEMPTION_FACILITY],
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: facilityToken,
            abi: erc4626Abi,
            functionName: 'convertToShares',
            args: [oneTargetRaw],
            blockNumber: state.blockNumber,
          }),
        ])
        const asset = normalizedAddress(assetRaw)
        if (
          !asset ||
          asset.toLowerCase() !== target.token.toLowerCase() ||
          maxDepositRaw < oneTargetRaw ||
          convertedSharesRaw === 0n
        ) {
          return null
        }
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
      const netYfiRaw = (grossYfiRaw * (WAD - feeRaw)) / WAD
      if (grossYfiRaw === 0n || grossYfiRaw > remainingCapacityRaw || netYfiRaw === 0n) {
        return null
      }

      const [yfiDecimals, yfiLiquidityRaw] = await Promise.all([
        tokenDecimals(state.client, yfi, state.blockNumber),
        state.client.readContract({
          address: yfi,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [REDEMPTION_FACILITY],
          blockNumber: state.blockNumber,
        }),
      ])
      if (yfiLiquidityRaw < netYfiRaw) {
        return null
      }

      const conversion = {
        ...blockEvidence(state, target),
        method: 'yip88-net-redemption',
        valuationRule: 'enabled-capacity-and-liquidity-checked-net-redemption',
        facility: REDEMPTION_FACILITY,
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
        references: ['https://docs.yearn.fi/contributing/governance/yips/yip-88'],
      }
      const input = await context.require(
        childTarget(target, yfi, state.numericBlockNumber),
        'YIP-88 redemption YFI',
      )
      return {
        priceUsd: calculateWrapperPrice(
          netYfiRaw,
          yfiDecimals,
          oneTargetRaw,
          targetDecimals,
          input.priceUsd,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion,
      }
    },
  }
}
