import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { calculateCompoundTokenPrice } from '../math'
import { plannedAdapter, type PlannedPriceAdapter } from '../plan'

const compoundAbi = parseAbi([
  'function underlying() view returns (address)',
  'function exchangeRateStored() view returns (uint256)'
])

export function compoundAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('compound-exchange-rate', async (target) => {
    const state = await contractContext(target, options)
    const [underlyingRaw, exchangeRateRaw] = await Promise.all([
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: compoundAbi,
          functionName: 'underlying',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: compoundAbi,
          functionName: 'exchangeRateStored',
          blockNumber: state.blockNumber
        })
      )
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
      tokenDecimals(state.client, underlying, state.blockNumber)
    ])
    const conversion = {
      ...blockEvidence(state, target),
      method: 'exchangeRateStored',
      underlying,
      exchangeRateRaw: rawState(exchangeRateRaw),
      shareDecimals,
      underlyingDecimals
    }
    return {
      dependencies: [
        { target: childTarget(target, underlying, state.numericBlockNumber), label: 'Compound underlying' }
      ],
      metadata: conversion,
      evaluate([input]) {
        return {
          priceUsd: calculateCompoundTokenPrice(
            exchangeRateRaw,
            shareDecimals,
            underlyingDecimals,
            input.priceUsd
          ),
          blockNumber: state.numericBlockNumber,
          inputs: [recursiveInput(input, conversion)],
          metadata: conversion
        }
      }
    }
  })
}
