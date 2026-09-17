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
import { calculatePoolNavPrice } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)'
])

/** Prices an LP token at the NAV of its reserves, so every leg must be priced. */
export function pairAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('amm-reserve-nav', async (target) => {
    const state = await contractContext(target, options)
    const [token0Raw, token1Raw, reserves, totalSupplyRaw, poolDecimalsRaw] = await Promise.all([
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
    return {
      dependencies: [token0, token1].map((address) => ({
        target: childTarget(target, address, state.numericBlockNumber),
        label: 'AMM constituent'
      })),
      metadata,
      evaluate(inputs) {
        return {
          priceUsd: calculatePoolNavPrice(
            [
              {
                address: token0,
                balanceRaw: reserves[0],
                decimals: token0Decimals,
                priceUsd: inputs[0].priceUsd
              },
              {
                address: token1,
                balanceRaw: reserves[1],
                decimals: token1Decimals,
                priceUsd: inputs[1].priceUsd
              }
            ],
            totalSupplyRaw,
            poolDecimals
          ),
          blockNumber: state.numericBlockNumber,
          inputs: inputs.map((path, index) =>
            recursiveInput(path, {
              method: 'pool-reserve-nav',
              balanceRaw: rawState(balances[index]),
              decimals: decimals[index]
            })
          ),
          metadata
        }
      }
    }
  })
}
