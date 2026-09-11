import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  erc20Abi,
  normalizedAddress,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { calculateWrapperPrice } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

const BEETS_BAR_WRAPPERS: Record<number, ReadonlySet<string>> = {
  250: new Set(['0xfcef8a994209d6916eb2c86cdd2afd60aa6f54b1'])
}

const beetsBarAbi = parseAbi(['function vestingToken() view returns (address)'])

export function beetsBarAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('beets-bar-share-rate', async (target) => {
    if (!BEETS_BAR_WRAPPERS[target.chainId]?.has(target.token.toLowerCase())) {
      return null
    }

    const state = await contractContext(target, options)
    const underlyingRaw = await state.client.readContract({
      address: state.address,
      abi: beetsBarAbi,
      functionName: 'vestingToken',
      blockNumber: state.blockNumber
    })
    const underlying = normalizedAddress(underlyingRaw)
    if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
      return null
    }

    const [shareDecimals, underlyingDecimals, totalSupplyRaw, underlyingBalanceRaw] = await Promise.all([
      tokenDecimals(state.client, target.token, state.blockNumber),
      tokenDecimals(state.client, underlying, state.blockNumber),
      state.client.readContract({
        address: state.address,
        abi: erc20Abi,
        functionName: 'totalSupply',
        blockNumber: state.blockNumber
      }),
      state.client.readContract({
        address: underlying,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [state.address],
        blockNumber: state.blockNumber
      })
    ])
    const conversion = {
      ...blockEvidence(state, target),
      method: 'beets-bar-pro-rata-underlying',
      underlying,
      shareDecimals,
      underlyingDecimals,
      totalSupplyRaw: rawState(totalSupplyRaw),
      underlyingBalanceRaw: rawState(underlyingBalanceRaw),
      valuationRule: 'all-underlying-bpt-constituents-required'
    }
    return {
      dependencies: [
        {
          target: childTarget(target, underlying, state.numericBlockNumber),
          label: 'BeetsBar underlying BPT'
        }
      ],
      metadata: conversion,
      evaluate([input]) {
        return {
          priceUsd: calculateWrapperPrice(
            underlyingBalanceRaw,
            underlyingDecimals,
            totalSupplyRaw,
            shareDecimals,
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
