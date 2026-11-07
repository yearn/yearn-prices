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
import type { ResolvedPricePath } from '../types'

const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function stable() view returns (bool)',
  'function factory() view returns (address)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)'
])

const factoryAbi = parseAbi([
  'function getPool(address,address,bool) view returns (address)',
  'function isPaused() view returns (bool)'
])
// Official Velodrome V2 and Aerodrome factories. The factory must attest the
// pool at the requested block before we trust its stable-swap quote interface.
export const STABLE_PAIR_FACTORIES: Readonly<Record<number, Address>> = {
  10: '0xf1046053aa5682b4f9a81b5481394da16be5ff5a',
  8453: '0x420dd381b31aef6683db6b902084cb0ffece40da'
}
export const MIN_STABLE_ANCHOR_USD = 20_000
// For x³y + xy³, the extreme-skew limit pays 7/8 of the anchor
// for a whole missing reserve marked at 3× the anchor: 7/24, not
// constant-product's 1/2. Leave room for fees/rounding below that floor.
export const MIN_STABLE_EXECUTABLE_SHARE = 0.25

/** Reserve NAV, with guarded pool quotes for a missing stable-pool constituent. */
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
    const totalSupply = totalSupplyRaw
    function quote(inputs: Array<ResolvedPricePath | null>, prices: number[], extra: Record<string, unknown> = {}) {
      return {
        priceUsd: calculatePoolNavPrice(
          tokens.map((address, index) => ({
            address,
            balanceRaw: balances[index],
            decimals: decimals[index],
            priceUsd: prices[index]
          })),
          totalSupply,
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
        if (index < 0 || !anchor || balances[index] <= 0n) return null
        const pricedValue = scaledRaw(balances[1 - index], decimals[1 - index]) * anchor.priceUsd
        if (stable === true) {
          const factory = STABLE_PAIR_FACTORIES[state.chainId]
          if (!factory) return null
          const reportedFactory = await maybe(() =>
            state.client.readContract({
              address: state.address,
              abi: pairAbi,
              functionName: 'factory',
              blockNumber: state.blockNumber
            })
          )
          if (reportedFactory?.toLowerCase() !== factory) return null
          const [registered, paused] = await Promise.all([
            state.client.readContract({
              address: factory,
              abi: factoryAbi,
              functionName: 'getPool',
              args: [token0 as Address, token1 as Address, true],
              blockNumber: state.blockNumber
            }),
            state.client.readContract({
              address: factory,
              abi: factoryAbi,
              functionName: 'isPaused',
              blockNumber: state.blockNumber
            })
          ])
          if (registered.toLowerCase() !== target.token.toLowerCase())
            throw new InvalidPricingError('Stable pool factory registration mismatch')
          if (paused) throw new InvalidPricingError('Stable pool swaps are paused at the requested block')
          if (pricedValue < MIN_STABLE_ANCHOR_USD)
            throw new InvalidPricingError(
              `Stable pool anchor liquidity $${pricedValue} is below $${MIN_STABLE_ANCHOR_USD}`
            )
          const holdings = await Promise.all(
            tokens.map((address) =>
              state.client.readContract({
                address: address as Address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [state.address],
                blockNumber: state.blockNumber
              })
            )
          )
          if (holdings.some((held, i) => held < balances[i]))
            throw new InvalidPricingError('Stable pool reserves exceed token holdings')
          const unit = 10n ** BigInt(decimals[index])
          const fraction = balances[index] / 10_000n || 1n
          const dxRaw = unit < fraction ? unit : fraction
          const [dyRaw, executableDyRaw] = await Promise.all(
            [dxRaw, balances[index]].map((amountIn) =>
              state.client.readContract({
                address: state.address,
                abi: pairAbi,
                functionName: 'getAmountOut',
                args: [amountIn, tokens[index] as Address],
                blockNumber: state.blockNumber
              })
            )
          )
          if (dyRaw <= 0n || executableDyRaw <= 0n)
            throw new InvalidPricingError('Stable pool swap quote has no executable output')
          const impliedPriceUsd =
            (scaledRaw(dyRaw, decimals[1 - index]) * anchor.priceUsd) / scaledRaw(dxRaw, decimals[index])
          const markedValue = scaledRaw(balances[index], decimals[index]) * impliedPriceUsd
          const executableValue = scaledRaw(executableDyRaw, decimals[1 - index]) * anchor.priceUsd
          // Bound the marked leg by both its full-reserve payout and the
          // independently priced reserve. A tiny quote alone proves no depth.
          if (
            !Number.isFinite(markedValue) ||
            markedValue <= 0 ||
            executableDyRaw > balances[1 - index] ||
            executableValue < MIN_STABLE_EXECUTABLE_SHARE * markedValue ||
            markedValue > pricedValue / MIN_STABLE_EXECUTABLE_SHARE
          )
            throw new InvalidPricingError('Stable pool derived reserve fails executable-value bound')
          return quote(
            inputs,
            inputs.map((path) => path?.priceUsd ?? impliedPriceUsd),
            {
              valuationRule: 'stable-swap-derived-constituent',
              factory,
              anchorLiquidityUsd: pricedValue,
              derivedReserves: [
                {
                  index,
                  address: tokens[index],
                  anchorIndex: 1 - index,
                  impliedPriceUsd,
                  dxRaw: rawState(dxRaw),
                  dyRaw: rawState(dyRaw),
                  executableDxRaw: rawState(balances[index]),
                  executableDyRaw: rawState(executableDyRaw),
                  minimumExecutableShare: MIN_STABLE_EXECUTABLE_SHARE
                }
              ]
            }
          )
        }
        if (stable !== false) return null
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
