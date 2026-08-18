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
import { calculateWrapperPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const underlyingAbis = [
  parseAbi(['function token() view returns (address)']),
  parseAbi(['function underlying() view returns (address)']),
  parseAbi(['function want() view returns (address)'])
] as const

const rateAbis = [
  { name: 'pricePerShare', abi: parseAbi(['function pricePerShare() view returns (uint256)']) },
  {
    name: 'getPricePerShare',
    abi: parseAbi(['function getPricePerShare() view returns (uint256)'])
  },
  {
    name: 'getPricePerFullShare',
    abi: parseAbi(['function getPricePerFullShare() view returns (uint256)'])
  }
] as const

export function yearnShareAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'yearn-share-rate',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      let underlying: `0x${string}` | null = null
      for (const abi of underlyingAbis) {
        const candidate = await maybe(() =>
          state.client.readContract({
            address: state.address,
            abi,
            functionName: abi[0].name,
            blockNumber: state.blockNumber
          })
        )
        if (typeof candidate === 'string') {
          underlying = normalizedAddress(candidate)
          if (underlying) {
            break
          }
        }
      }
      if (!underlying || underlying.toLowerCase() === target.token.toLowerCase()) {
        return null
      }

      let rate: { method: string; raw: bigint } | null = null
      for (const candidate of rateAbis) {
        const raw = await maybe(() =>
          state.client.readContract({
            address: state.address,
            abi: candidate.abi,
            functionName: candidate.name,
            blockNumber: state.blockNumber
          })
        )
        if (typeof raw === 'bigint') {
          rate = { method: candidate.name, raw }
          break
        }
      }
      if (!rate) {
        return null
      }

      const [shareDecimals, underlyingDecimals] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        tokenDecimals(state.client, underlying, state.blockNumber)
      ])
      // Only getPricePerFullShare is a fixed 1e18 ratio. The other rates return
      // an amount of the underlying, and a Yearn vault takes its own decimals
      // from that underlying, so the share decimals are the right scale here.
      const rateDecimals = rate.method === 'getPricePerFullShare' ? 18 : shareDecimals
      const conversion = {
        ...blockEvidence(state, target),
        method: rate.method,
        underlying,
        rateRaw: rawState(rate.raw),
        rateDecimals,
        shareDecimals,
        underlyingDecimals
      }
      const input = await context.require(
        childTarget(target, underlying, state.numericBlockNumber),
        'Yearn share underlying'
      )
      return {
        priceUsd: calculateWrapperPrice(
          rate.raw,
          rateDecimals,
          10n ** BigInt(shareDecimals),
          shareDecimals,
          input.priceUsd
        ),
        blockNumber: state.numericBlockNumber,
        inputs: [recursiveInput(input, conversion)],
        metadata: conversion
      }
    }
  }
}
