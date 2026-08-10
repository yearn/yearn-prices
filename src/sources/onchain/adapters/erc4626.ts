import { erc4626Abi } from '../abis'
import {
  blockEvidence,
  childTarget,
  contractContext,
  erc20Abi,
  maybe,
  normalizedAddress,
  rawState,
  recursiveInput,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculateWrapperPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

export function erc4626Adapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'erc4626-convert-to-assets',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [underlyingRaw, shareDecimalsRaw] = await Promise.all([
        maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: erc4626Abi,
            functionName: 'asset',
            blockNumber: state.blockNumber,
          }),
        ),
        maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: erc20Abi,
            functionName: 'decimals',
            blockNumber: state.blockNumber,
          }),
        ),
      ])
      if (!underlyingRaw || shareDecimalsRaw == null) {
        return null
      }
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
        return null
      }

      const shareDecimals = Number(shareDecimalsRaw)
      const oneShareRaw = 10n ** BigInt(shareDecimals)
      let method = 'convertToAssets'
      let convertedAssetsRaw = await maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: erc4626Abi,
          functionName: 'convertToAssets',
          args: [oneShareRaw],
          blockNumber: state.blockNumber,
        }),
      )
      if (convertedAssetsRaw == null) {
        method = 'previewRedeem'
        convertedAssetsRaw = await maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: erc4626Abi,
            functionName: 'previewRedeem',
            args: [oneShareRaw],
            blockNumber: state.blockNumber,
          }),
        )
      }
      if (convertedAssetsRaw == null) {
        return null
      }

      const underlyingDecimals = await tokenDecimals(state.client, underlying, state.blockNumber)
      const conversion = {
        ...blockEvidence(state, target),
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
