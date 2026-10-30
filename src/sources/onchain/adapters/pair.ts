import { parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  erc20Abi,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { calculatePoolNavPrice, scaledRaw } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'
import type { ResolvedPricePath } from '../types'

const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function stable() view returns (bool)'
])

/** Prices an LP token at the NAV of its reserves. A volatile Solidly pair may derive one unpriced leg. */
export function pairAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('amm-reserve-nav', async (target) => {
    const state = await contractContext(target, options)
    const [token0Raw, token1Raw, reserves, totalSupplyRaw, poolDecimalsRaw, stable] = await Promise.all([
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'token0',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'token1',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'getReserves',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber: state.blockNumber
        })
      ),
      maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: pairAbi,
          functionName: 'stable',
          blockNumber: state.blockNumber
        })
      )
    ])
    if (!token0Raw || !token1Raw || !reserves || totalSupplyRaw == null || poolDecimalsRaw == null) {
      return null
    }
    const token0 = normalizedAddress(token0Raw)
    const token1 = normalizedAddress(token1Raw)
    if (!token0 || !token1) {
      return null
    }

    const [token0Decimals, token1Decimals] = await Promise.all([
      tokenDecimals(state.client, token0, state.blockNumber),
      tokenDecimals(state.client, token1, state.blockNumber)
    ])
    const decimals = [token0Decimals, token1Decimals]
    const balances = [reserves[0], reserves[1]]
    const poolDecimals = Number(poolDecimalsRaw)
    const metadata = {
      ...blockEvidence(state, target),
      valuationRule: 'all-constituents-required',
      totalSupplyRaw: rawState(totalSupplyRaw),
      poolDecimals,
      reserves: [
        { address: token0, decimals: token0Decimals, balanceRaw: rawState(reserves[0]) },
        { address: token1, decimals: token1Decimals, balanceRaw: rawState(reserves[1]) }
      ]
    }
    const tokens = [token0, token1]
    function quote(inputs: Array<ResolvedPricePath | null>, prices: number[], extra: Record<string, unknown> = {}) {
      return {
        priceUsd: calculatePoolNavPrice(
          tokens.map((address, index) => ({
            address,
            balanceRaw: balances[index],
            decimals: decimals[index],
            priceUsd: prices[index]
          })),
          totalSupplyRaw,
          poolDecimals
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.flatMap((path, index) =>
          path
            ? [
                recursiveInput(path, {
                  method: 'pool-reserve-nav',
                  balanceRaw: rawState(balances[index]),
                  decimals: decimals[index]
                })
              ]
            : []
        ),
        metadata: { ...metadata, ...extra }
      }
    }
    return {
      dependencies: tokens.map((address) => ({
        target: childTarget(target, address, state.numericBlockNumber),
        label: 'AMM constituent'
      })),
      metadata,
      evaluate(inputs) {
        return quote(
          inputs,
          inputs.map((path) => path.priceUsd)
        )
      },
      async derive(inputs) {
        const index = inputs.findIndex((path) => !path)
        const anchor = inputs[1 - index]
        if (stable !== false || index < 0 || !anchor || balances[index] <= 0n) return null
        const pricedValue = scaledRaw(balances[1 - index], decimals[1 - index]) * anchor.priceUsd
        const impliedPriceUsd = pricedValue / scaledRaw(balances[index], decimals[index])
        const prices = inputs.map((path) => path?.priceUsd ?? impliedPriceUsd)
        return quote(inputs, prices, {
          valuationRule: 'constant-product-derived-constituent',
          derivedReserves: [{ index, address: tokens[index], anchorIndex: 1 - index, impliedPriceUsd }]
        })
      }
    }
  })
}
