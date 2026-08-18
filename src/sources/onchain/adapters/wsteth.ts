import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  rawState,
  recursiveInput,
  type OnchainAdapterOptions
} from '../context'
import { calculateWrapperPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const wstEthAbi = parseAbi([
  'function stETH() view returns (address)',
  'function stEthPerToken() view returns (uint256)'
])

export function wstEthAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'wsteth-rate',
    async resolve(target, context) {
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
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'wstETH underlying'
      )
      return {
        priceUsd: calculateWrapperPrice(rateRaw, 18, 10n ** 18n, 18, input.priceUsd),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion
      }
    }
  }
}
