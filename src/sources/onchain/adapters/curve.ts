import { type Address, encodeFunctionData, type PublicClient, parseAbi } from 'viem'
import {
  blockEvidence,
  type ContractContext,
  childTarget,
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
import type { PlannedPriceAdapter } from '../plan'
import { WRAPPED_NATIVE } from '../tokens'
import type { RecursivePriceContext, RecursivePriceTarget, ResolvedPricePath } from '../types'

const CURVE_ADDRESS_PROVIDER = '0x0000000022D53366457F9d5E68Ec105046FC4383' as Address
const CURVE_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const MAX_REGISTRY_ID = 12
const MAX_COINS = 8
/**
 * Smallest share of a derived leg's marked value the pool must actually pay out
 * when the whole leg is swapped into the anchor. A one-unit quote says nothing
 * about depth, so a drained or skewed stableswap marks a reserve far above what
 * it could settle and its whole-reserve payout falls toward zero. A
 * constant-product curve (crypto-v2) pays about half the one-unit mark for a
 * whole reserve, at any skew; fees scale both quotes so they cancel in the
 * ratio. 0.4 sits below that ~0.5 floor so every balanced pool of both families
 * is accepted, while a drained stableswap is still refused.
 *
 * Bound: every derived leg is marked at most 1 / MIN_EXECUTABLE_SHARE times
 * what the anchor pays for it, and all derived legs together are marked at
 * most 1 / MIN_EXECUTABLE_SHARE times the anchor's own value, so the anchor
 * plus derived legs are at most (1 + 1 / MIN_EXECUTABLE_SHARE) times the
 * anchor's value. Other market-priced coins are extra.
 */
const MIN_EXECUTABLE_SHARE = 0.4

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
const registryCoinsAbi = parseAbi(['function get_coins(address) view returns (address[8])'])
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
  source: 'pool-N_COINS' | 'curve-registry' | 'curve-metaregistry' | 'curve-registry-coins'
  coins?: string[]
  registry?: string
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

type GetDyAbi = typeof getDyUintAbi | typeof getDyIntAbi

async function readGetDy(
  client: PublicClient,
  poolAddress: Address,
  fromIndex: number,
  toIndex: number,
  dxRaw: bigint,
  blockNumber: bigint,
  abiSlot: { abi: GetDyAbi | null }
): Promise<bigint | null> {
  const candidates: GetDyAbi[] = abiSlot.abi ? [abiSlot.abi] : [getDyUintAbi, getDyIntAbi]
  for (const abi of candidates) {
    const quote = await maybe(() =>
      client.readContract({
        address: poolAddress,
        abi,
        functionName: 'get_dy',
        args: [BigInt(fromIndex), BigInt(toIndex), dxRaw],
        blockNumber
      })
    )
    if (quote != null) {
      abiSlot.abi = abi
      return quote
    }
  }
  return null
}

/**
 * Values the coins the market cannot price by quoting one unit of each against
 * the most valuable priced reserve. The anchor carries the only market price behind
 * every derived leg, so each leg must be executable against the anchor at close
 * to the rate it is marked at, and the derived legs together may not be marked
 * far above what the anchor is worth.
 */
async function deriveMissingLegs(
  state: ContractContext,
  poolAddress: Address,
  coins: CurveCoin[],
  marketPrices: Array<number | null>
): Promise<{ prices: number[]; derivedCoins: Record<string, unknown>[] } | null> {
  let anchorIndex = -1
  let anchorValue = -1
  marketPrices.forEach((price, index) => {
    if (price == null || !Number.isFinite(price) || price <= 0) {
      return
    }
    const value = scaledRaw(coins[index].balanceRaw, coins[index].decimals) * price
    if (Number.isFinite(value) && value > anchorValue) {
      anchorIndex = index
      anchorValue = value
    }
  })
  if (anchorIndex < 0 || anchorValue <= 0) {
    return null
  }
  const anchorPrice = marketPrices[anchorIndex] as number

  const prices = [...marketPrices]
  const derivedCoins: Record<string, unknown>[] = []
  let derivedValue = 0
  const abiSlot: { abi: GetDyAbi | null } = { abi: null }
  for (const index of marketPrices.flatMap((price, i) => (price == null ? [i] : []))) {
    const dxRaw = 10n ** BigInt(coins[index].decimals)
    const getDyRaw = await readGetDy(state.client, poolAddress, index, anchorIndex, dxRaw, state.blockNumber, abiSlot)
    if (getDyRaw == null || getDyRaw === 0n) {
      return null
    }
    const derivedPrice = scaledRaw(getDyRaw, coins[anchorIndex].decimals) * anchorPrice
    if (!Number.isFinite(derivedPrice) || derivedPrice <= 0) {
      return null
    }
    const balanceRaw = coins[index].balanceRaw
    const markedValue = scaledRaw(balanceRaw, coins[index].decimals) * derivedPrice
    let executableDyRaw: bigint | null = null
    if (markedValue > 0) {
      executableDyRaw = await readGetDy(
        state.client,
        poolAddress,
        index,
        anchorIndex,
        balanceRaw,
        state.blockNumber,
        abiSlot
      )
      if (executableDyRaw == null) {
        return null
      }
      const executableValue = scaledRaw(executableDyRaw, coins[anchorIndex].decimals) * anchorPrice
      if (!Number.isFinite(executableValue) || executableValue < MIN_EXECUTABLE_SHARE * markedValue) {
        return null
      }
    }

    prices[index] = derivedPrice
    derivedValue += markedValue
    derivedCoins.push({
      coinIndex: index,
      address: coins[index].address,
      anchorCoinIndex: anchorIndex,
      anchorAddress: coins[anchorIndex].address,
      dxRaw: rawState(dxRaw),
      getDyRaw: rawState(getDyRaw),
      executableDxRaw: rawState(balanceRaw),
      executableDyRaw: executableDyRaw == null ? null : rawState(executableDyRaw)
    })
  }

  if (derivedValue > anchorValue / MIN_EXECUTABLE_SHARE) {
    return null
  }
  return { prices: prices as number[], derivedCoins }
}

function validCoinCount(value: bigint): number | null {
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 && count <= MAX_COINS ? count : null
}

/** Read the complete fixed-array return data, rather than decoding a shorter
 * ABI array and silently truncating a larger pool. Dynamic/ambiguous arrays
 * are deliberately excluded; the supported legacy interfaces return fixed arrays. */
async function fixedWords(
  client: PublicClient,
  address: Address,
  data: `0x${string}`,
  blockNumber: bigint
): Promise<string[] | null> {
  const response = await maybe(() => client.call({ to: address, data, blockNumber }))
  const raw = response?.data
  if (!raw || !/^0x(?:[0-9a-fA-F]{64})+$/.test(raw)) return null
  const words = raw.slice(2).match(/.{64}/g)!
  if (words.length < 1 || words.length > MAX_COINS) return null
  if (words.length >= 2 && BigInt(`0x${words[0]}`) === 32n && BigInt(`0x${words[1]}`) === BigInt(words.length - 2))
    return null
  return words
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

  const counted = await forEachRegistry(async (registry) => {
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
  if (counted) return counted
  return forEachRegistry(async (registry) => {
    const words = await fixedWords(
      client,
      registry,
      encodeFunctionData({ abi: registryCoinsAbi, functionName: 'get_coins', args: [poolAddress] }),
      blockNumber
    )
    if (!words || words.some((word) => !/^0{24}/.test(word))) return null
    const addresses = words.map((word) => `0x${word.slice(24)}`)
    const count = addresses.findIndex((address) => /^0x0+$/.test(address))
    const coins = count < 0 ? addresses : addresses.slice(0, count)
    if (!coins.length || (count >= 0 && addresses.slice(count).some((address) => !/^0x0+$/.test(address)))) return null
    return { count: coins.length, source: 'curve-registry-coins', coins, registry } satisfies CurveCoinCount
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

export function curveAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  const discover = async (target: RecursivePriceTarget) => {
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
      if (coinCount.coins && coin.address.toLowerCase() !== coinCount.coins[index].toLowerCase()) {
        throw new InvalidPricingError('Curve registry coin list disagrees with pool')
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

    const [poolDecimals, totalSupplyRaw] = await Promise.all([
      tokenDecimals(state.client, target.token, state.blockNumber),
      state.client.readContract({
        address: state.address,
        abi: erc20Abi,
        functionName: 'totalSupply',
        blockNumber: state.blockNumber
      })
    ])
    const metadata = {
      ...blockEvidence(state, target),
      poolAddress,
      coinCount: coinCount.count,
      coinCountSource: coinCount.source,
      ...(coinCount.registry ? { coinCountRegistry: coinCount.registry, registryCoins: coinCount.coins } : {}),
      valuationRule: 'all-constituents-required',
      totalSupplyRaw: rawState(totalSupplyRaw),
      poolDecimals,
      coins: coins.map((coin) => ({
        address: coin.address,
        onchainAddress: coin.onchainAddress,
        decimals: coin.decimals,
        balanceRaw: rawState(coin.balanceRaw)
      }))
    }
    function quote(inputs: Array<ResolvedPricePath | null>, prices: number[], derivedCoins: Record<string, unknown>[]) {
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
        metadata: {
          ...metadata,
          valuationRule: derivedCoins.length === 0 ? 'all-constituents-required' : 'get-dy-derived-constituents',
          ...(derivedCoins.length > 0 ? { derivedCoins } : {})
        }
      }
    }
    return {
      dependencies: coins.map((coin) => ({
        target: childTarget(target, coin.address, state.numericBlockNumber),
        label: 'Curve constituent'
      })),
      metadata,
      evaluate(inputs: ResolvedPricePath[]) {
        return quote(
          inputs,
          inputs.map((path) => path.priceUsd),
          []
        )
      },
      // Recursive resolution preserves main's conditional RPC fallback. Graph
      // evaluation remains pure and requires every declared constituent.
      async resolve(context: RecursivePriceContext) {
        const inputs = await optionalChildren(
          context,
          target,
          coins.map((coin) => coin.address),
          state.numericBlockNumber,
          'Curve constituent'
        )
        const marketPrices = inputs.map((path) => path?.priceUsd ?? null)
        const derived = marketPrices.some((price) => price == null)
          ? await deriveMissingLegs(state, poolAddress as Address, coins, marketPrices)
          : { prices: marketPrices as number[], derivedCoins: [] }
        return derived ? quote(inputs, derived.prices, derived.derivedCoins) : null
      }
    }
  }
  return {
    name: 'curve-reserve-nav',
    discover,
    async resolve(target, context) {
      const plan = await discover(target)
      return plan ? plan.resolve(context) : null
    }
  }
}
