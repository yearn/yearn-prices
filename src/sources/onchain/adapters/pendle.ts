import { type Address, parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput
} from '../context'
import { calculateWrapperPrice } from '../math'
import { plannedAdapter, type PlannedPriceAdapter } from '../plan'

const PENDLE_ORACLE = '0x9a9Fa8338dd5E5B2188006f1Cd2Ef26d921650C2' as Address
const MAX_UINT32 = 4_294_967_295

export const DEFAULT_PENDLE_TWAP_SECONDS = 900

const marketAbi = parseAbi(['function readTokens() view returns (address sy, address pt, address yt)'])
const syAbi = parseAbi([
  'function assetInfo() view returns (uint8 assetType, address asset, uint8 assetDecimals)'
])
const oracleAbi = parseAbi([
  'function getLpToAssetRate(address market, uint32 duration) view returns (uint256)'
])

/** Prices a Pendle LP against its SY asset using the oracle's TWAP rate. */
export function pendleAdapter(options: OnchainAdapterOptions, twapSeconds: number): PlannedPriceAdapter {
  if (!Number.isInteger(twapSeconds) || twapSeconds < 1 || twapSeconds > MAX_UINT32) {
    throw new Error('Pendle TWAP seconds must fit uint32 and be positive')
  }

  return plannedAdapter('pendle-oracle-lp-to-asset', async (target) => {
    const state = await contractContext(target, options)
    const tokens = await maybe(() =>
      state.client.readContract({
        address: state.address,
        abi: marketAbi,
        functionName: 'readTokens',
        blockNumber: state.blockNumber
      })
    )
    if (!tokens) {
      return null
    }
    const assetInfo = await maybe(() =>
      state.client.readContract({
        address: tokens[0],
        abi: syAbi,
        functionName: 'assetInfo',
        blockNumber: state.blockNumber
      })
    )
    if (!assetInfo) {
      return null
    }
    const asset = normalizedAddress(assetInfo[1])
    if (!asset || asset.toLowerCase() === target.token.toLowerCase()) {
      return null
    }

    const rateRaw = await state.client.readContract({
      address: PENDLE_ORACLE,
      abi: oracleAbi,
      functionName: 'getLpToAssetRate',
      args: [state.address, twapSeconds],
      blockNumber: state.blockNumber
    })
    const conversion = {
      ...blockEvidence(state, target),
      method: 'getLpToAssetRate',
      oracleAddress: PENDLE_ORACLE,
      twapSeconds,
      syToken: tokens[0],
      ptToken: tokens[1],
      ytToken: tokens[2],
      asset,
      assetType: Number(assetInfo[0]),
      assetDecimals: Number(assetInfo[2]),
      rateDecimals: 18,
      lpToAssetRateRaw: rawState(rateRaw)
    }
    return {
      dependencies: [
        { target: childTarget(target, asset, state.numericBlockNumber), label: 'Pendle SY asset' }
      ],
      metadata: conversion,
      evaluate([input]) {
        return {
          priceUsd: calculateWrapperPrice(rateRaw, 18, 10n ** 18n, 18, input.priceUsd),
          blockNumber: state.numericBlockNumber,
          inputs: [recursiveInput(input, conversion)],
          metadata: conversion
        }
      }
    }
  })
}
