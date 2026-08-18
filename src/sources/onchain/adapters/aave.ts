import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  recursiveInput,
  type OnchainAdapterOptions
} from '../context'
import type { RecursivePriceAdapter } from '../types'

const aaveAbi = parseAbi(['function UNDERLYING_ASSET_ADDRESS() view returns (address)'])

/** Aave aTokens are redeemable one-for-one for their underlying asset. */
export function aaveAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'aave-underlying-parity',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const underlyingRaw = await maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: aaveAbi,
          functionName: 'UNDERLYING_ASSET_ADDRESS',
          blockNumber: state.blockNumber
        })
      )
      if (!underlyingRaw) {
        return null
      }
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
        return null
      }

      const conversion = { ...blockEvidence(state, target), method: 'one-to-one', underlying }
      const input = await context.require(childTarget(target, underlying, state.numericBlockNumber), 'Aave underlying')
      return {
        priceUsd: input.priceUsd,
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion
      }
    }
  }
}
