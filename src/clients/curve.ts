import { type PublicClient, parseAbi } from 'viem'

// Curve AddressProvider is deployed at the same address on every Curve chain.
const ADDRESS_PROVIDER = '0x0000000022D53366457F9d5E68Ec105046FC4383' as const
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const ADDRESS_PROVIDER_ABI = parseAbi(['function get_registry() view returns (address)'])
const REGISTRY_ABI = parseAbi([
  'function get_pool_from_lp_token(address) view returns (address)',
  'function get_coins(address) view returns (address[8])'
])
const VIRTUAL_PRICE_ABI = parseAbi(['function get_virtual_price() view returns (uint256)'])

const registryCache = new Map<number, `0x${string}` | null>()
const poolCache = new Map<string, `0x${string}` | null>()

function isZero(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS
}

async function getRegistry(client: PublicClient, chainId: number): Promise<`0x${string}` | null> {
  if (registryCache.has(chainId)) {
    return registryCache.get(chainId)!
  }

  let result: `0x${string}`
  try {
    result = await client.readContract({
      address: ADDRESS_PROVIDER,
      abi: ADDRESS_PROVIDER_ABI,
      functionName: 'get_registry'
    })
  } catch {
    // Transient RPC error — don't cache, so the next item retries.
    return null
  }

  const registry = isZero(result) ? null : result
  registryCache.set(chainId, registry)
  return registry
}

async function resolvePool(
  client: PublicClient,
  chainId: number,
  registry: `0x${string}`,
  lpToken: `0x${string}`
): Promise<`0x${string}` | null> {
  const cacheKey = `${chainId}:${lpToken.toLowerCase()}`
  const cached = poolCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  let result: `0x${string}`
  try {
    result = await client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'get_pool_from_lp_token',
      args: [lpToken]
    })
  } catch {
    // Transient RPC error — don't cache, so the next item retries.
    return null
  }

  const pool = isZero(result) ? null : result
  poolCache.set(cacheKey, pool)
  return pool
}

/**
 * Prices a Curve LP token in USD from its pool's virtual price:
 *   lpUsd = get_virtual_price() / 1e18 * price(coin0)
 * `get_virtual_price` is denominated in the pool's underlying unit, so scaling
 * by the first coin's USD price yields the LP's USD value (exact for stable
 * pools, where every coin is ~the same value). Returns null when the token is
 * not a registered Curve LP or coin0 has no price.
 *
 * Coverage: `get_registry()` returns the classic stableswap registry, so only
 * stableswap-registry pools resolve here. Factory pools (LP == pool) and
 * crypto-registry pools are not in this registry and return null — that
 * narrowing is exactly what keeps the stableswap-only math (below) safe.
 */
export async function priceCurveLpUsd(
  client: PublicClient,
  chainId: number,
  lpToken: `0x${string}`,
  blockNumber: bigint,
  fetchCoinPriceUsd: (coin: `0x${string}`) => Promise<number | null>
): Promise<number | null> {
  const registry = await getRegistry(client, chainId)
  if (!registry) {
    return null
  }

  const pool = await resolvePool(client, chainId, registry, lpToken)
  if (!pool) {
    return null
  }

  const [virtualPrice, coins] = await Promise.all([
    client.readContract({
      address: pool,
      abi: VIRTUAL_PRICE_ABI,
      functionName: 'get_virtual_price',
      blockNumber
    }),
    client.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'get_coins',
      args: [pool],
      blockNumber
    })
  ])

  const coin0 = coins.find((coin) => !isZero(coin))
  if (!coin0) {
    return null
  }

  const coin0Price = await fetchCoinPriceUsd(coin0)
  if (coin0Price == null) {
    return null
  }

  // Assumes a stableswap pool (all coins ~equal value); the stableswap-registry
  // lookup above is what guarantees only such pools reach this line.
  return (Number(virtualPrice) / 1e18) * coin0Price
}
