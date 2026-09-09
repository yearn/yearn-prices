import { parseAbi } from 'viem'
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

const wstEthAbi = parseAbi([
  'function stETH() view returns (address)',
  'function stEthPerToken() view returns (uint256)'
])

export function wstEthAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('wsteth-rate', async (target) => {
    const state = await contractContext(target, options)
    const [underlyingRaw, rateRaw] = await Promise.all([
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: wstEthAbi,
          functionName: 'stETH',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: wstEthAbi,
          functionName: 'stEthPerToken',
          blockNumber: state.blockNumber
        })
      )
    ])
    if (!underlyingRaw || rateRaw == null) {
      return null
    }
    const underlying = normalizedAddress(underlyingRaw)
    if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
      return null
    }

    const conversion = {
      ...blockEvidence(state, target),
      method: 'stEthPerToken',
      underlying,
      rateRaw: rawState(rateRaw),
      rateDecimals: 18
    }
    return {
      dependencies: [
        { target: childTarget(target, underlying, state.numericBlockNumber), label: 'wstETH underlying' }
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
