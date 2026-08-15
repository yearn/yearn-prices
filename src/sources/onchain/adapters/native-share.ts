import {
  blockEvidence,
  childTarget,
  contractContext,
  rawState,
  readShareConversion,
  recursiveInput,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculateWrapperPrice } from '../math'
import { WRAPPED_NATIVE } from '../tokens'
import type { RecursivePriceAdapter } from '../types'

/** Wrappers that hold the chain's native asset rather than an ERC-20. */
const NATIVE_SHARE_WRAPPERS: Record<number, ReadonlySet<string>> = {
  1: new Set(['0x09db87a538bd693e9d08544577d5ccfaa6373a48']),
}

/**
 * ERC-4626-shaped wrappers whose asset is the chain's native currency, so
 * `asset()` is absent and the underlying is the wrapped native token.
 */
export function nativeShareAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'native-share-convert-to-assets',
    async resolve(target, context) {
      if (!NATIVE_SHARE_WRAPPERS[target.chainId]?.has(target.token.toLowerCase())) {
        return null
      }
      const nativeAsset = WRAPPED_NATIVE[target.chainId]
      if (!nativeAsset) {
        return null
      }

      const state = await contractContext(target, options)
      const shareDecimals = await tokenDecimals(state.client, target.token, state.blockNumber)
      const oneShareRaw = 10n ** BigInt(shareDecimals)
      const conversionRaw = await readShareConversion(
        state.client,
        state.address,
        state.blockNumber,
        oneShareRaw,
      )
      if (!conversionRaw) {
        return null
      }
      const { method, convertedAssetsRaw } = conversionRaw

      const conversion = {
        ...blockEvidence(state, target),
        method,
        underlying: nativeAsset,
        shareDecimals,
        underlyingDecimals: 18,
        oneShareRaw: rawState(oneShareRaw),
        convertedAssetsRaw: rawState(convertedAssetsRaw),
        valuationRule: 'allowlisted-native-share-conversion',
      }
      const input = await context.require(
        childTarget(target, nativeAsset, state.numericBlockNumber),
        'native share underlying',
      )
      return {
        priceUsd: calculateWrapperPrice(
          convertedAssetsRaw,
          18,
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
