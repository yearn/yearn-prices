import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  rawState,
  recursiveInput,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculateCompoundTokenPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const compoundAbi = parseAbi([
  'function underlying() view returns (address)',
  'function exchangeRateStored() view returns (uint256)',
])

export function compoundAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'compound-exchange-rate',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const [underlyingRaw, exchangeRateRaw] = await Promise.all([
        maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: compoundAbi,
            functionName: 'underlying',
            blockNumber: state.blockNumber,
          }),
        ),
        maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: compoundAbi,
            functionName: 'exchangeRateStored',
            blockNumber: state.blockNumber,
          }),
        ),
      ])
      if (!underlyingRaw || exchangeRateRaw == null) {
        return null
      }
      const underlying = normalizedAddress(underlyingRaw)
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
        return null
      }

      const [shareDecimals, underlyingDecimals] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        tokenDecimals(state.client, underlying, state.blockNumber),
      ])
      const conversion = {
        ...blockEvidence(state, target),
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
