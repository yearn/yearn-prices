import { type Address, type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp } from '../../clients/rpc'
import { resolveCurvePoolCoins } from '../onchain/adapters/curve'
import { type ClientForChain, maybe } from '../onchain/context'

export const CURVE_LP_BOUND_FACTOR = 4

const virtualPriceAbi = parseAbi(['function get_virtual_price() view returns (uint256)'])

export type CoinPrice = (chainId: number, coin: string, timestamp: number) => Promise<number | null>

export interface CurveLpGuardOptions {
  clientForChain: ClientForChain
  coinPrice: CoinPrice
  blockForTimestamp?: (client: PublicClient, chainId: number, timestamp: number) => Promise<bigint>
}

export type PlausibleQuote = (chainId: number, token: string, timestamp: number, price: number) => Promise<boolean>

export function createCurveLpGuard(options: CurveLpGuardOptions): PlausibleQuote {
  const blockForTimestamp = options.blockForTimestamp ?? estimateBlockByTimestamp
  const pools = new Map<string, Promise<{ pool: Address; coins: string[] } | null>>()

  const poolFor = (chainId: number, token: string) => {
    const key = `${chainId}:${token.toLowerCase()}`
    let pending = pools.get(key)
    if (!pending) {
      pending = resolveCurvePoolCoins({ chainId, token, timestamp: null }, options)
      pending.catch(() => pools.delete(key))
      pools.set(key, pending)
    }
    return pending
  }

  return async (chainId, token, timestamp, price) => {
    const client = options.clientForChain(chainId)
    if (!client) {
      return true
    }
    const lp = await poolFor(chainId, token)
    if (!lp) {
      return true
    }
    const blockNumber = await blockForTimestamp(client, chainId, timestamp)
    const virtualPrice = await maybe(() =>
      client.readContract({ address: lp.pool, abi: virtualPriceAbi, functionName: 'get_virtual_price', blockNumber })
    )
    if (virtualPrice == null) {
      return true
    }
    const coinPrices = await Promise.all(lp.coins.map((coin) => options.coinPrice(chainId, coin, timestamp)))
    if (coinPrices.some((coinPrice) => coinPrice == null || !(coinPrice > 0))) {
      return true
    }
    return price <= CURVE_LP_BOUND_FACTOR * (Number(virtualPrice) / 1e18) * Math.max(...(coinPrices as number[]))
  }
}
