import { parseAbi } from 'viem'
import {
  blockEvidence,
  contractContext,
  erc20Abi,
  normalizedAddress,
  rawState,
  recursiveInput,
  requireChildren,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculatePoolNavPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const RESERVE_RTOKENS: Record<number, ReadonlySet<string>> = {
  1: new Set([
    '0x78da5799cf427fee11e9996982f4150ece7a99a7',
    '0xacdf0dba4b9839b96221a8487e9ca660a48212be',
    '0xfc0b1eef20e4c68b3dcf36c4537cfa7ce46ca70b',
  ]),
}

const reserveRTokenAbi = parseAbi([
  'function main() view returns (address)',
  'function basketsNeeded() view returns (uint192)',
  'function redemptionAvailable() view returns (uint256)',
])
const reserveMainAbi = parseAbi([
  'function basketHandler() view returns (address)',
  'function frozen() view returns (bool)',
])
const reserveBasketHandlerAbi = parseAbi([
  'function fullyCollateralized() view returns (bool)',
  'function quote(uint192 amount, uint8 rounding) view returns (address[] erc20s, uint256[] quantities)',
])

/**
 * Prices an RToken at what one token actually redeems for. Every guard the
 * protocol puts on redemption is checked first: a frozen, under-collateralized
 * or throttled RToken is not priced at all.
 */
export function reserveRTokenAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'reserve-rtoken-redemption',
    async resolve(target, context) {
      if (!RESERVE_RTOKENS[target.chainId]?.has(target.token.toLowerCase())) {
        return null
      }

      const state = await contractContext(target, options)
      const [mainRaw, tokenDecimalsRaw, totalSupplyRaw, basketsNeededRaw, redemptionAvailableRaw] =
        await Promise.all([
          state.client.readContract({
            address: state.address,
            abi: reserveRTokenAbi,
            functionName: 'main',
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: state.address,
            abi: erc20Abi,
            functionName: 'decimals',
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: state.address,
            abi: erc20Abi,
            functionName: 'totalSupply',
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: state.address,
            abi: reserveRTokenAbi,
            functionName: 'basketsNeeded',
            blockNumber: state.blockNumber,
          }),
          state.client.readContract({
            address: state.address,
            abi: reserveRTokenAbi,
            functionName: 'redemptionAvailable',
            blockNumber: state.blockNumber,
          }),
        ])
      const main = normalizedAddress(mainRaw)
      if (!main || totalSupplyRaw === 0n || basketsNeededRaw === 0n) {
        return null
      }

      const rTokenDecimals = Number(tokenDecimalsRaw)
      const oneTokenRaw = 10n ** BigInt(rTokenDecimals)
      if (redemptionAvailableRaw < oneTokenRaw) {
        return null
      }
      const basketUnitsRaw = (basketsNeededRaw * oneTokenRaw) / totalSupplyRaw
      if (basketUnitsRaw === 0n) {
        return null
      }

      const [basketHandlerRaw, frozen] = await Promise.all([
        state.client.readContract({
          address: main,
          abi: reserveMainAbi,
          functionName: 'basketHandler',
          blockNumber: state.blockNumber,
        }),
        state.client.readContract({
          address: main,
          abi: reserveMainAbi,
          functionName: 'frozen',
          blockNumber: state.blockNumber,
        }),
      ])
      const basketHandler = normalizedAddress(basketHandlerRaw)
      if (!basketHandler || frozen) {
        return null
      }

      const fullyCollateralized = await state.client.readContract({
        address: basketHandler,
        abi: reserveBasketHandlerAbi,
        functionName: 'fullyCollateralized',
        blockNumber: state.blockNumber,
      })
      if (!fullyCollateralized) {
        return null
      }
      const quote = await state.client.readContract({
        address: basketHandler,
        abi: reserveBasketHandlerAbi,
        functionName: 'quote',
        args: [basketUnitsRaw, 0],
        blockNumber: state.blockNumber,
      })
      if (quote[0].length === 0 || quote[0].length !== quote[1].length) {
        return null
      }

      const constituents: Array<{ address: string; amountRaw: bigint }> = []
      for (const [index, address] of quote[0].entries()) {
        const amountRaw = quote[1][index]
        if (amountRaw === 0n) {
          continue
        }
        const normalized = normalizedAddress(address)
        if (!normalized) {
          return null
        }
        constituents.push({ address: normalized, amountRaw })
      }
      if (constituents.length === 0) {
        return null
      }

      const [decimals, inputs] = await Promise.all([
        Promise.all(
          constituents.map((asset) => tokenDecimals(state.client, asset.address, state.blockNumber)),
        ),
        requireChildren(
          context,
          target,
          constituents.map((asset) => asset.address),
          state.numericBlockNumber,
          'Reserve RToken redemption constituent',
        ),
      ])
      const metadata = {
        ...blockEvidence(state, target),
        method: 'reserve-rtoken-basket-redemption',
        valuationRule: 'fully-collateralized-complete-redemption-basket',
        main,
        basketHandler,
        tokenDecimals: rTokenDecimals,
        oneTokenRaw: rawState(oneTokenRaw),
        totalSupplyRaw: rawState(totalSupplyRaw),
        basketsNeededRaw: rawState(basketsNeededRaw),
        basketUnitsRaw: rawState(basketUnitsRaw),
        redemptionAvailableRaw: rawState(redemptionAvailableRaw),
        constituents: constituents.map((asset, index) => ({
          address: asset.address,
          decimals: decimals[index],
          amountRaw: rawState(asset.amountRaw),
        })),
      }
      return {
        priceUsd: calculatePoolNavPrice(
          constituents.map((asset, index) => ({
            address: asset.address,
            balanceRaw: asset.amountRaw,
            decimals: decimals[index],
            priceUsd: inputs[index].priceUsd,
          })),
          oneTokenRaw,
          rTokenDecimals,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) =>
          recursiveInput(path, {
            method: 'reserve-rtoken-basket-redemption',
            amountRaw: rawState(constituents[index].amountRaw),
            decimals: decimals[index],
          }),
        ),
        metadata,
      }
    },
  }
}
