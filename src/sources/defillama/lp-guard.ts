import { type Address, type PublicClient, parseAbi } from 'viem'
import { estimateBlockByTimestamp } from '../../clients/rpc'
import { resolveCurvePoolCoins } from '../onchain/adapters/curve'
import { type ClientForChain, maybe } from '../onchain/context'

export const CURVE_LP_BOUND_FACTOR = 4
const MAX_IN_FLIGHT = 8

const virtualPriceAbi = parseAbi(['function get_virtual_price() view returns (uint256)'])

export type CoinPrices = (chainId: number, coins: string[], timestamp: number) => Promise<(number | null)[]>

export interface CurveLpGuardOptions {
  clientForChain: ClientForChain
  coinPrices: CoinPrices
  blockForTimestamp?: (client: PublicClient, chainId: number, timestamp: number) => Promise<bigint>
}

export type PlausibleQuote = (chainId: number, token: string, timestamp: number, price: number) => Promise<boolean>

export function createCurveLpGuard(options: CurveLpGuardOptions): PlausibleQuote {
  const blockForTimestamp = options.blockForTimestamp ?? estimateBlockByTimestamp
  const pools = new Map<string, Promise<{ pool: Address; coins: string[] } | null>>()
  let inFlight = 0
  const waiting: (() => void)[] = []

  const poolFor = (chainId: number, token: string, timestamp: number) => {
    const key = `${chainId}:${token.toLowerCase()}`
    let pending = pools.get(key)
    if (!pending) {
      pending = resolveCurvePoolCoins(
        { chainId, token, timestamp },
        {
          ...options,
          blockForTarget: (client, id, target) => blockForTimestamp(client, id, target.timestamp ?? timestamp)
        }
      )
      pending.catch(() => pools.delete(key))
      pools.set(key, pending)
    }
    return pending
  }

  const skip = (chainId: number, token: string, timestamp: number, reason: string) => {
    console.warn(`lp-guard:unverified ${chainId}:${token} ${timestamp} ${reason}`)
    return true
  }

  const verdict = async (chainId: number, token: string, timestamp: number, price: number) => {
    const client = options.clientForChain(chainId)
    if (!client) {
      return true
    }
    const lp = await poolFor(chainId, token, timestamp)
    if (!lp) {
      return true
    }
    const blockNumber = await blockForTimestamp(client, chainId, timestamp)
    const virtualPrice = await maybe(() =>
      client.readContract({ address: lp.pool, abi: virtualPriceAbi, functionName: 'get_virtual_price', blockNumber })
    )
    if (virtualPrice == null) {
      return skip(chainId, token, timestamp, 'no-virtual-price')
    }
    const coinPrices = await options.coinPrices(chainId, lp.coins, timestamp)
    if (coinPrices.length !== lp.coins.length) {
      return skip(chainId, token, timestamp, 'coin-price-arity')
    }
    if (coinPrices.some((coinPrice) => coinPrice == null || !(coinPrice > 0))) {
      return skip(chainId, token, timestamp, 'no-coin-price')
    }
    return price <= CURVE_LP_BOUND_FACTOR * (Number(virtualPrice) / 1e18) * Math.max(...(coinPrices as number[]))
  }

  return async (chainId, token, timestamp, price) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    } else {
      inFlight += 1
    }
    try {
      return await verdict(chainId, token, timestamp, price)
    } catch (error) {
      console.warn(
        `lp-guard:skipped ${chainId}:${token} ${timestamp} ${error instanceof Error ? error.message : String(error)}`
      )
      return true
    } finally {
      const next = waiting.shift()
      if (next) next()
      else inFlight -= 1
    }
  }
}
