import { parseAbi, type Address, type PublicClient } from 'viem'
import {
  blockEvidence,
  contractContext,
  erc20Abi,
  maybe,
  normalizedAddress,
  rawState,
  recursiveInput,
  requireChildren,
  tokenDecimals,
  type ContractContext,
  type OnchainAdapterOptions,
} from '../context'
import { InvalidPricingError } from '../errors'
import { calculatePoolNavPrice } from '../math'
import { WRAPPED_NATIVE } from '../tokens'
import type { RecursivePriceAdapter, RecursivePriceTarget } from '../types'

const CURVE_ADDRESS_PROVIDER = '0x0000000022D53366457F9d5E68Ec105046FC4383' as Address
const CURVE_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const MAX_REGISTRY_ID = 12
const MAX_COINS = 8

const minterAbi = parseAbi(['function minter() view returns (address)'])
const poolLpTokenAbi = parseAbi([
  'function token() view returns (address)',
  'function lp_token() view returns (address)',
])
const providerAbi = parseAbi(['function get_address(uint256) view returns (address)'])
const registryAbi = parseAbi([
  'function get_pool_from_lp_token(address) view returns (address)',
  'function get_n_coins(address) view returns (uint256[2])',
])
const metaRegistryAbi = parseAbi(['function get_n_coins(address) view returns (uint256)'])
const poolCoinCountAbi = parseAbi(['function N_COINS() view returns (uint256)'])
const coinUintAbi = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)',
])
const coinIntAbi = parseAbi([
  'function coins(int128) view returns (address)',
  'function balances(int128) view returns (uint256)',
])

interface CurveCoin {
  address: string
  onchainAddress: string
  decimals: number
  balanceRaw: bigint
}

interface CurveCoinCount {
  count: number
  source: 'pool-N_COINS' | 'curve-registry' | 'curve-metaregistry'
}

async function forEachRegistry<T>(
  client: PublicClient,
  blockNumber: bigint,
  visit: (registry: Address) => Promise<T | null>,
): Promise<T | null> {
  for (let registryId = 0; registryId <= MAX_REGISTRY_ID; registryId += 1) {
    const registryRaw = await maybe(() =>
      client.readContract({
        address: CURVE_ADDRESS_PROVIDER,
        abi: providerAbi,
        functionName: 'get_address',
        args: [BigInt(registryId)],
        blockNumber,
      }),
    )
    if (!registryRaw) {
      continue
    }
    const registry = normalizedAddress(registryRaw)
    if (!registry) {
      continue
    }
    const result = await visit(registry)
    if (result != null) {
      return result
    }
  }
  return null
}

async function poolFromRegistry(
  client: PublicClient,
  lpToken: Address,
  blockNumber: bigint,
): Promise<string | null> {
  return forEachRegistry(client, blockNumber, async (registry) => {
    const poolRaw = await maybe(() =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: 'get_pool_from_lp_token',
        args: [lpToken],
        blockNumber,
      }),
    )
    return poolRaw ? normalizedAddress(poolRaw) : null
  })
}

async function readCoinAddress(
  client: PublicClient,
  poolAddress: Address,
  index: number,
  blockNumber: bigint,
): Promise<{ address: string; indexType: 'uint256' | 'int128' } | null> {
  const uintAddress = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: coinUintAbi,
      functionName: 'coins',
      args: [BigInt(index)],
      blockNumber,
    }),
  )
  if (uintAddress) {
    const address = normalizedAddress(uintAddress)
    if (address) {
      return { address, indexType: 'uint256' }
    }
  }
  const intAddress = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: coinIntAbi,
      functionName: 'coins',
      args: [BigInt(index)],
      blockNumber,
    }),
  )
  if (!intAddress) {
    return null
  }
  const address = normalizedAddress(intAddress)
  return address ? { address, indexType: 'int128' } : null
}

function validCoinCount(value: bigint): number | null {
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_COINS ? count : null
}

/**
 * The coin count must come from an authoritative source. Probing `coins(i)`
 * until it reverts would silently undercount a pool and overprice the LP.
 */
async function readCoinCount(
  client: PublicClient,
  poolAddress: Address,
  blockNumber: bigint,
): Promise<CurveCoinCount | null> {
  const direct = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: poolCoinCountAbi,
      functionName: 'N_COINS',
      blockNumber,
    }),
  )
  const directCount = direct == null ? null : validCoinCount(direct)
  if (directCount != null) {
    return { count: directCount, source: 'pool-N_COINS' }
  }

  return forEachRegistry(client, blockNumber, async (registry) => {
    const registryCounts = await maybe(() =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: 'get_n_coins',
        args: [poolAddress],
        blockNumber,
      }),
    )
    const registryCount = registryCounts == null ? null : validCoinCount(registryCounts[0])
    if (registryCount != null) {
      return { count: registryCount, source: 'curve-registry' } satisfies CurveCoinCount
    }

    const metaRegistryCountRaw = await maybe(() =>
      client.readContract({
        address: registry,
        abi: metaRegistryAbi,
        functionName: 'get_n_coins',
        args: [poolAddress],
        blockNumber,
      }),
    )
    const metaRegistryCount =
      metaRegistryCountRaw == null ? null : validCoinCount(metaRegistryCountRaw)
    return metaRegistryCount == null
      ? null
      : ({ count: metaRegistryCount, source: 'curve-metaregistry' } satisfies CurveCoinCount)
  })
}

/**
 * A minter() answer is self-reported by the token being priced, so the pool
 * itself must claim the token back as its LP before it is trusted. Otherwise a
 * counterfeit token could point at a real pool and be priced from its reserves.
 */
async function poolClaimsLpToken(
  client: PublicClient,
  pool: Address,
  lpToken: string,
  blockNumber: bigint,
): Promise<boolean> {
  for (const functionName of ['token', 'lp_token'] as const) {
    const claimed = await maybe(() =>
      client.readContract({ address: pool, abi: poolLpTokenAbi, functionName, blockNumber }),
    )
    if (claimed && claimed.toLowerCase() === lpToken.toLowerCase()) {
      return true
    }
  }
  return false
}

async function resolvePool(
  target: RecursivePriceTarget,
  state: ContractContext,
): Promise<string | null> {
  const minterRaw = await maybe(() =>
    state.client.readContract({
      address: state.address,
      abi: minterAbi,
      functionName: 'minter',
      blockNumber: state.blockNumber,
    }),
  )
  if (minterRaw) {
    const minter = normalizedAddress(minterRaw)
    if (
      minter &&
      (await poolClaimsLpToken(state.client, minter as Address, target.token, state.blockNumber))
    ) {
      return minter
    }
  }
  if (await readCoinAddress(state.client, state.address, 0, state.blockNumber)) {
    return target.token
  }
  return poolFromRegistry(state.client, state.address, state.blockNumber)
}

export function curveAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'curve-reserve-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const poolAddress = await resolvePool(target, state)
      if (!poolAddress) {
        return null
      }
      const coinCount = await readCoinCount(state.client, poolAddress as Address, state.blockNumber)
      if (!coinCount) {
        return null
      }

      const coins: CurveCoin[] = []
      for (let index = 0; index < coinCount.count; index += 1) {
        const coin = await readCoinAddress(
          state.client,
          poolAddress as Address,
          index,
          state.blockNumber,
        )
        if (!coin) {
          throw new InvalidPricingError(
            `Curve coin ${index} is unavailable despite authoritative count ${coinCount.count}`,
          )
        }
        const isNative = coin.address.toLowerCase() === CURVE_NATIVE_TOKEN
        const pricingAddress = isNative ? WRAPPED_NATIVE[state.chainId] : coin.address
        if (!pricingAddress) {
          throw new Error(
            `No wrapped native asset is configured for Curve on chain ${state.chainId}`,
          )
        }
        const decimals = isNative
          ? 18
          : await tokenDecimals(state.client, coin.address, state.blockNumber)
        const balanceRaw = await state.client.readContract({
          address: poolAddress as Address,
          abi: coin.indexType === 'uint256' ? coinUintAbi : coinIntAbi,
          functionName: 'balances',
          args: [BigInt(index)],
          blockNumber: state.blockNumber,
        })
        coins.push({ address: pricingAddress, onchainAddress: coin.address, decimals, balanceRaw })
      }
      if (coins.length === 0) {
        return null
      }

      const [poolDecimals, totalSupplyRaw, inputs] = await Promise.all([
        tokenDecimals(state.client, target.token, state.blockNumber),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        }),
        requireChildren(
          context,
          target,
          coins.map((coin) => coin.address),
          state.numericBlockNumber,
          'Curve constituent',
        ),
      ])
      const metadata = {
        ...blockEvidence(state, target),
        poolAddress,
        coinCount: coinCount.count,
        coinCountSource: coinCount.source,
        valuationRule: 'all-constituents-required',
        totalSupplyRaw: rawState(totalSupplyRaw),
        poolDecimals,
        coins: coins.map((coin) => ({
          address: coin.address,
          onchainAddress: coin.onchainAddress,
          decimals: coin.decimals,
          balanceRaw: rawState(coin.balanceRaw),
        })),
      }
      return {
        priceUsd: calculatePoolNavPrice(
          coins.map((coin, index) => ({ ...coin, priceUsd: inputs[index].priceUsd })),
          totalSupplyRaw,
          poolDecimals,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) =>
          recursiveInput(path, {
            method: 'curve-reserve-nav',
            balanceRaw: rawState(coins[index].balanceRaw),
            decimals: coins[index].decimals,
          }),
        ),
        metadata,
      }
    },
  }
}
