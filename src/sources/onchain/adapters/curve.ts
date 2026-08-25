import { type Address, type PublicClient, parseAbi } from 'viem'
import {
  blockEvidence,
  type ContractContext,
  contractContext,
  erc20Abi,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  optionalChildren,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { InvalidPricingError } from '../errors'
import { calculatePoolNavPrice, scaledRaw } from '../math'
import { WRAPPED_NATIVE } from '../tokens'
import type { RecursivePriceAdapter, RecursivePriceTarget } from '../types'

const CURVE_ADDRESS_PROVIDER = '0x0000000022D53366457F9d5E68Ec105046FC4383' as Address
const CURVE_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const MAX_REGISTRY_ID = 12
const MAX_COINS = 8
/** Smallest share of pool value the priced anchor may hold and still be a price. */
const MIN_ANCHOR_SHARE = 0.01

const minterAbi = parseAbi(['function minter() view returns (address)'])
const poolLpTokenAbi = parseAbi([
  'function token() view returns (address)',
  'function lp_token() view returns (address)'
])
const providerAbi = parseAbi(['function get_address(uint256) view returns (address)'])
const registryAbi = parseAbi([
  'function get_pool_from_lp_token(address) view returns (address)',
  'function get_n_coins(address) view returns (uint256[2])'
])
const metaRegistryAbi = parseAbi(['function get_n_coins(address) view returns (uint256)'])
const poolCoinCountAbi = parseAbi(['function N_COINS() view returns (uint256)'])
const coinUintAbi = parseAbi([
  'function coins(uint256) view returns (address)',
  'function balances(uint256) view returns (uint256)'
])
const coinIntAbi = parseAbi([
  'function coins(int128) view returns (address)',
  'function balances(int128) view returns (uint256)'
])
const getDyUintAbi = parseAbi(['function get_dy(uint256,uint256,uint256) view returns (uint256)'])
const getDyIntAbi = parseAbi(['function get_dy(int128,int128,uint256) view returns (uint256)'])

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

type RegistryWalk = <T>(visit: (registry: Address) => Promise<T | null>) => Promise<T | null>

/**
 * Walks the address provider's registries, remembering each answer. The pool
 * lookup and the coin count both walk it, and a registry address does not
 * change inside one resolution.
 */
function registryWalk(client: PublicClient, blockNumber: bigint): RegistryWalk {
  const seen = new Map<number, Address | null>()

  return async function forEachRegistry<T>(visit: (registry: Address) => Promise<T | null>): Promise<T | null> {
    for (let registryId = 0; registryId <= MAX_REGISTRY_ID; registryId += 1) {
      let registry = seen.get(registryId)
      if (registry === undefined) {
        const registryRaw = await maybe(() =>
          client.readContract({
            address: CURVE_ADDRESS_PROVIDER,
            abi: providerAbi,
            functionName: 'get_address',
            args: [BigInt(registryId)],
            blockNumber
          })
        )
        registry = (registryRaw ? normalizedAddress(registryRaw) : null) as Address | null
        seen.set(registryId, registry)
      }
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
}

async function poolFromRegistry(
  client: PublicClient,
  lpToken: Address,
  blockNumber: bigint,
  forEachRegistry: RegistryWalk
): Promise<string | null> {
  return forEachRegistry(async (registry) => {
    const poolRaw = await maybe(() =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: 'get_pool_from_lp_token',
        args: [lpToken],
        blockNumber
      })
    )
    return poolRaw ? normalizedAddress(poolRaw) : null
  })
}

async function readCoinAddress(
  client: PublicClient,
  poolAddress: Address,
  index: number,
  blockNumber: bigint
): Promise<{ address: string; indexType: 'uint256' | 'int128' } | null> {
  const uintAddress = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: coinUintAbi,
      functionName: 'coins',
      args: [BigInt(index)],
      blockNumber
    })
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
      blockNumber
    })
  )
  if (!intAddress) {
    return null
  }
  const address = normalizedAddress(intAddress)
  return address ? { address, indexType: 'int128' } : null
}

async function readGetDy(
  client: PublicClient,
  poolAddress: Address,
  fromIndex: number,
  toIndex: number,
  dxRaw: bigint,
  blockNumber: bigint
): Promise<bigint | null> {
  const uintQuote = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: getDyUintAbi,
      functionName: 'get_dy',
      args: [BigInt(fromIndex), BigInt(toIndex), dxRaw],
      blockNumber
    })
  )
  if (uintQuote != null) {
    return uintQuote
  }
  return maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: getDyIntAbi,
      functionName: 'get_dy',
      args: [BigInt(fromIndex), BigInt(toIndex), dxRaw],
      blockNumber
    })
  )
}

/**
 * Values the coins the market cannot price by quoting one unit of each against
 * the largest priced reserve. The anchor carries the only market price behind
 * every derived leg, so a pool whose anchor holds a negligible share of its
 * value gets no price at all rather than one resting on dust.
 */
async function deriveMissingLegs(
  state: ContractContext,
  poolAddress: Address,
  coins: CurveCoin[],
  marketPrices: Array<number | null>
): Promise<{ prices: number[]; derivedCoins: Record<string, unknown>[] } | null> {
  const pricedIndexes = marketPrices.flatMap((price, index) => (price == null ? [] : [index]))
  if (pricedIndexes.length === 0) {
    return null
  }
  let anchorIndex = pricedIndexes[0]
  let anchorBalance = scaledRaw(coins[anchorIndex].balanceRaw, coins[anchorIndex].decimals)
  for (const index of pricedIndexes.slice(1)) {
    const balance = scaledRaw(coins[index].balanceRaw, coins[index].decimals)
    if (balance > anchorBalance) {
      anchorIndex = index
      anchorBalance = balance
    }
  }
  const anchorPrice = marketPrices[anchorIndex]
  if (anchorPrice == null || !Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    return null
  }

  const prices = [...marketPrices]
  const derivedCoins: Record<string, unknown>[] = []
  for (const index of marketPrices.flatMap((price, i) => (price == null ? [i] : []))) {
    const dxRaw = 10n ** BigInt(coins[index].decimals)
    const getDyRaw = await readGetDy(state.client, poolAddress, index, anchorIndex, dxRaw, state.blockNumber)
    if (getDyRaw == null || getDyRaw === 0n) {
      return null
    }
    const derivedPrice = scaledRaw(getDyRaw, coins[anchorIndex].decimals) * anchorPrice
    if (!Number.isFinite(derivedPrice) || derivedPrice <= 0) {
      return null
    }
    prices[index] = derivedPrice
    derivedCoins.push({
      coinIndex: index,
      address: coins[index].address,
      anchorCoinIndex: anchorIndex,
      anchorAddress: coins[anchorIndex].address,
      dxRaw: rawState(dxRaw),
      getDyRaw: rawState(getDyRaw)
    })
  }

  const values = coins.map((coin, index) => scaledRaw(coin.balanceRaw, coin.decimals) * (prices[index] as number))
  const totalValue = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(totalValue) || totalValue <= 0 || values[anchorIndex] / totalValue < MIN_ANCHOR_SHARE) {
    return null
  }
  return { prices: prices as number[], derivedCoins }
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
  forEachRegistry: RegistryWalk
): Promise<CurveCoinCount | null> {
  const direct = await maybe(() =>
    client.readContract({
      address: poolAddress,
      abi: poolCoinCountAbi,
      functionName: 'N_COINS',
      blockNumber
    })
  )
  const directCount = direct == null ? null : validCoinCount(direct)
  if (directCount != null) {
    return { count: directCount, source: 'pool-N_COINS' }
  }

  return forEachRegistry(async (registry) => {
    const registryCounts = await maybe(() =>
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: 'get_n_coins',
        args: [poolAddress],
        blockNumber
      })
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
        blockNumber
      })
    )
    const metaRegistryCount = metaRegistryCountRaw == null ? null : validCoinCount(metaRegistryCountRaw)
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
  blockNumber: bigint
): Promise<boolean> {
  for (const functionName of ['token', 'lp_token'] as const) {
    const claimed = await maybe(() =>
      client.readContract({ address: pool, abi: poolLpTokenAbi, functionName, blockNumber })
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
  forEachRegistry: RegistryWalk
): Promise<string | null> {
  const minterRaw = await maybe(() =>
    state.client.readContract({
      address: state.address,
      abi: minterAbi,
      functionName: 'minter',
      blockNumber: state.blockNumber
    })
  )
  if (minterRaw) {
    const minter = normalizedAddress(minterRaw)
    if (minter && (await poolClaimsLpToken(state.client, minter as Address, target.token, state.blockNumber))) {
      return minter
    }
  }
  if (await readCoinAddress(state.client, state.address, 0, state.blockNumber)) {
    return target.token
  }
  return poolFromRegistry(state.client, state.address, state.blockNumber, forEachRegistry)
}

export function curveAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'curve-reserve-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const forEachRegistry = registryWalk(state.client, state.blockNumber)
      const poolAddress = await resolvePool(target, state, forEachRegistry)
      if (!poolAddress) {
        return null
      }
      const coinCount = await readCoinCount(state.client, poolAddress as Address, state.blockNumber, forEachRegistry)
      if (!coinCount) {
        return null
      }

      const coins: CurveCoin[] = []
      for (let index = 0; index < coinCount.count; index += 1) {
        const coin = await readCoinAddress(state.client, poolAddress as Address, index, state.blockNumber)
        if (!coin) {
          throw new InvalidPricingError(
            `Curve coin ${index} is unavailable despite authoritative count ${coinCount.count}`
          )
        }
        const isNative = coin.address.toLowerCase() === CURVE_NATIVE_TOKEN
        const pricingAddress = isNative ? WRAPPED_NATIVE[state.chainId] : coin.address
        if (!pricingAddress) {
          throw new Error(`No wrapped native asset is configured for Curve on chain ${state.chainId}`)
        }
        const decimals = isNative ? 18 : await tokenDecimals(state.client, coin.address, state.blockNumber)
        const balanceRaw = await state.client.readContract({
          address: poolAddress as Address,
          abi: coin.indexType === 'uint256' ? coinUintAbi : coinIntAbi,
          functionName: 'balances',
          args: [BigInt(index)],
          blockNumber: state.blockNumber
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
          blockNumber: state.blockNumber
        }),
        optionalChildren(
          context,
          target,
          coins.map((coin) => coin.address),
          state.numericBlockNumber,
          'Curve constituent'
        )
      ])

      const marketPrices = inputs.map((path) => path?.priceUsd ?? null)
      const derived = marketPrices.some((price) => price == null)
        ? await deriveMissingLegs(state, poolAddress as Address, coins, marketPrices)
        : { prices: marketPrices as number[], derivedCoins: [] }
      if (!derived) {
        return null
      }
      const { prices, derivedCoins } = derived

      const metadata = {
        ...blockEvidence(state, target),
        poolAddress,
        coinCount: coinCount.count,
        coinCountSource: coinCount.source,
        valuationRule: derivedCoins.length === 0 ? 'all-constituents-required' : 'get-dy-derived-constituents',
        totalSupplyRaw: rawState(totalSupplyRaw),
        poolDecimals,
        coins: coins.map((coin) => ({
          address: coin.address,
          onchainAddress: coin.onchainAddress,
          decimals: coin.decimals,
          balanceRaw: rawState(coin.balanceRaw)
        })),
        ...(derivedCoins.length > 0 ? { derivedCoins } : {})
      }
      return {
        priceUsd: calculatePoolNavPrice(
          coins.map((coin, index) => ({ ...coin, priceUsd: prices[index] })),
          totalSupplyRaw,
          poolDecimals
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.flatMap((path, index) =>
          path
            ? [
                recursiveInput(path, {
                  method: 'curve-reserve-nav',
                  balanceRaw: rawState(coins[index].balanceRaw),
                  decimals: coins[index].decimals
                })
              ]
            : []
        ),
        metadata
      }
    }
  }
}
