import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS, type DefiLlamaClient } from '../../clients/defillama'
import { isRejectedPrice } from '../../prices/rejections'
import { chainNameToId } from '../../utils/chains'
import { chunk } from '../../utils/collections'
import { currentUtcDayEnd, nowUnix } from '../../utils/time'
import type { HistoricalPriceResult } from '../types'
import { toHistoricalPrice } from './coin'
import { DEFILLAMA_UNSUPPORTED_CHAINS } from './historical'

export const DEFI_LLAMA_CURRENT_BATCH = 50
export const CURRENT_MAX_AGE_SECONDS = DEFI_LLAMA_SEARCH_WIDTH_SECONDS
export const CURRENT_MAX_FUTURE_SKEW_SECONDS = 5 * 60

export interface CurrentPriceTarget {
  chain: string
  token: string
}

export function currentPriceKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

export async function fetchCurrentPrices(
  client: DefiLlamaClient,
  targets: CurrentPriceTarget[]
): Promise<Map<string, HistoricalPriceResult>> {
  const now = nowUnix()
  const todayEnd = currentUtcDayEnd(now)
  const coinKeys = new Set<string>()
  for (const { chain, token } of targets) {
    const chainId = chainNameToId(chain)
    if (chainId === undefined || DEFILLAMA_UNSUPPORTED_CHAINS.has(chainId)) continue
    if (isRejectedPrice(chain, token, todayEnd, 'defillama')) continue
    coinKeys.add(currentPriceKey(chain, token))
  }

  const prices = new Map<string, HistoricalPriceResult>()
  await Promise.all(
    chunk([...coinKeys], DEFI_LLAMA_CURRENT_BATCH).map(async (keys) => {
      const response = await client.getCurrent(keys)
      for (const key of keys) {
        const price = toHistoricalPrice(
          response.coins?.[key],
          (value, time) =>
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value > 0 &&
            typeof time === 'number' &&
            Number.isSafeInteger(time) &&
            now - time <= CURRENT_MAX_AGE_SECONDS &&
            time - now <= CURRENT_MAX_FUTURE_SKEW_SECONDS
        )
        if (price) prices.set(key, price)
      }
    })
  )
  return prices
}
