import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  recursiveInput
} from '../context'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

const aaveAbi = parseAbi(['function UNDERLYING_ASSET_ADDRESS() view returns (address)'])

/** Aave aTokens are redeemable one-for-one for their underlying asset. */
export function aaveAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('aave-underlying-parity', async (target) => {
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
    return {
      dependencies: [{ target: childTarget(target, underlying, state.numericBlockNumber), label: 'Aave underlying' }],
      metadata: conversion,
      evaluate([input]) {
        return {
          priceUsd: input.priceUsd,
          blockNumber: state.numericBlockNumber,
          inputs: [recursiveInput(input, conversion)],
          metadata: conversion
        }
      }
    }
  })
}
