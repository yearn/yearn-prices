import { type Address, parseAbi } from 'viem'
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
import { InvalidPricingError } from '../errors'
import { calculatePoolNavPrice, scaledRaw } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

const hypervisorAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function pool() view returns (address)',
  'function getTotalAmounts() view returns (uint256 total0, uint256 total1)'
])
const poolAbi = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)'])
// Algebra (QuickSwap) and Uniswap V3 both lead their state with sqrtPriceX96.
const algebraStateAbi = parseAbi(['function globalState() view returns (uint160 price, int24 tick)'])
const uniswapStateAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)'])

/**
 * Reviewed Gamma hypervisors. `getTotalAmounts` is what Gamma's deposit proxy
 * uses for share accounting: both position legs plus idle balances.
 */
export const GAMMA_HYPERVISORS: Readonly<Record<number, ReadonlySet<string>>> = {
  137: new Set([
    '0x3cc20a6795c4b57d9817399f68e83e71c8626580', // aUSDC-WETH (QuickSwap)
    '0x4b9e26a02121a1c541403a611b542965bd4b68ce', // aWBTC-WETH (QuickSwap)
    '0x8dd3bf71ef18dd88869d128bde058c9d8c270176', // aWMATIC-MATICX (QuickSwap)
    '0x04d521e2c414e6d898c6f2599fdd863edf49e247' // awMATIC-USDC (QuickSwap)
  ])
}

/**
 * A hypervisor's holdings are split at the pool's own price. Valuing them at
 * market prices is only meaningful while that price agrees with the market.
 */
export const MAX_POOL_PRICE_DEVIATION = 0.02

/** Hypervisor holdings at the historical block, valued at independent constituent prices. */
export function gammaAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('gamma-hypervisor-nav', async (target) => {
    if (!GAMMA_HYPERVISORS[target.chainId]?.has(target.token.toLowerCase())) return null
    const state = await contractContext(target, options)
    const { client, address, blockNumber } = state
    const [token0Raw, token1Raw, poolRaw, totals, totalSupplyRaw, poolDecimalsRaw] = await Promise.all([
      client.readContract({ address, abi: hypervisorAbi, functionName: 'token0', blockNumber }),
      client.readContract({ address, abi: hypervisorAbi, functionName: 'token1', blockNumber }),
      client.readContract({ address, abi: hypervisorAbi, functionName: 'pool', blockNumber }),
      client.readContract({ address, abi: hypervisorAbi, functionName: 'getTotalAmounts', blockNumber }),
      client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply', blockNumber }),
      client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber })
    ])
    const token0 = normalizedAddress(token0Raw)
    const token1 = normalizedAddress(token1Raw)
    const pool = normalizedAddress(poolRaw)
    if (!token0 || !token1 || !pool) throw new InvalidPricingError('Gamma hypervisor has an invalid token or pool')
    if (totalSupplyRaw <= 0n) throw new InvalidPricingError('Gamma hypervisor has zero supply at the requested block')

    const [poolToken0, poolToken1, algebraState] = await Promise.all([
      client.readContract({ address: pool as Address, abi: poolAbi, functionName: 'token0', blockNumber }),
      client.readContract({ address: pool as Address, abi: poolAbi, functionName: 'token1', blockNumber }),
      maybe(() =>
        client.readContract({
          address: pool as Address,
          abi: algebraStateAbi,
          functionName: 'globalState',
          blockNumber
        })
      )
    ])
    if (poolToken0.toLowerCase() !== token0.toLowerCase() || poolToken1.toLowerCase() !== token1.toLowerCase())
      throw new InvalidPricingError('Gamma hypervisor tokens do not match its pool')
    const sqrtPriceX96 =
      algebraState?.[0] ??
      (
        await client.readContract({
          address: pool as Address,
          abi: uniswapStateAbi,
          functionName: 'slot0',
          blockNumber
        })
      )[0]
    if (sqrtPriceX96 <= 0n) throw new InvalidPricingError('Gamma pool has no price at the requested block')

    const [token0Decimals, token1Decimals] = await Promise.all([
      tokenDecimals(client, token0, blockNumber),
      tokenDecimals(client, token1, blockNumber)
    ])
    const tokens = [token0, token1]
    const decimals = [token0Decimals, token1Decimals]
    const balances = [totals[0], totals[1]]
    const poolDecimals = Number(poolDecimalsRaw)
    // token1 per token0 in whole units.
    const poolPrice = (Number(sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (token0Decimals - token1Decimals)
    const metadata = {
      ...blockEvidence(state, target),
      valuationRule: 'all-constituents-required',
      pool,
      sqrtPriceX96: rawState(sqrtPriceX96),
      poolPrice,
      totalSupplyRaw: rawState(totalSupplyRaw),
      poolDecimals,
      reserves: tokens.map((token, index) => ({
        address: token,
        decimals: decimals[index],
        balanceRaw: rawState(balances[index])
      }))
    }
    return {
      dependencies: tokens.map((token) => ({
        target: childTarget(target, token, state.numericBlockNumber),
        label: 'Gamma constituent'
      })),
      metadata,
      evaluate(inputs) {
        const marketPrice = inputs[0].priceUsd / inputs[1].priceUsd
        const deviation = Math.abs(poolPrice / marketPrice - 1)
        if (!Number.isFinite(deviation) || deviation > MAX_POOL_PRICE_DEVIATION)
          throw new InvalidPricingError(
            `Gamma pool price ${poolPrice} deviates ${deviation} from market ${marketPrice}, above ${MAX_POOL_PRICE_DEVIATION}`
          )
        const priceUsd = calculatePoolNavPrice(
          tokens.map((token, index) => ({
            address: token,
            balanceRaw: balances[index],
            decimals: decimals[index],
            priceUsd: inputs[index].priceUsd
          })),
          totalSupplyRaw,
          poolDecimals
        )
        return {
          priceUsd,
          blockNumber: state.numericBlockNumber,
          inputs: inputs.map((input, index) =>
            recursiveInput(input, {
              method: 'gamma-total-amounts',
              balanceRaw: rawState(balances[index]),
              decimals: decimals[index]
            })
          ),
          metadata: {
            ...metadata,
            marketPrice,
            deviation,
            navUsd: scaledRaw(totalSupplyRaw, poolDecimals) * priceUsd
          }
        }
      }
    }
  })
}
