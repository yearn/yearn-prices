import { DefiLlamaClient } from '../../clients/defillama'
import { ApiError } from '../../http/errors'
import { isRejectedPrice } from '../../prices/rejections'
import { chainIdToName } from '../../utils/chains'
import { nowUnix, toFetchTimestamp } from '../../utils/time'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../types'
import { buildDefiLlamaPayloads } from './batch'
import { toHistoricalPrice } from './coin'
import { matchPricesToRequests } from './match'

export const DEFILLAMA_UNSUPPORTED_CHAINS: ReadonlySet<number> = new Set([4663])
/** Keep batch payloads from arriving at the provider in a synchronized burst. */
export const DEFI_LLAMA_HISTORICAL_CONCURRENCY = 2

function isMalformedBatchCoin(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
  const prices = (value as { prices?: unknown }).prices
  return (
    !Array.isArray(prices) ||
    prices.some((sample: unknown) => {
      if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return true
      const observation = sample as { price?: unknown; timestamp?: unknown }
      return typeof observation.price !== 'number' || typeof observation.timestamp !== 'number'
    })
  )
}

export class DefiLlamaHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'defillama'
  readonly priority = 10

  constructor(private readonly client: DefiLlamaClient = new DefiLlamaClient()) {
    super()
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined && !DEFILLAMA_UNSUPPORTED_CHAINS.has(chainId)
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    if (DEFILLAMA_UNSUPPORTED_CHAINS.has(chainId)) {
      return null
    }
    const chain = chainIdToName(chainId)
    if (!chain || isRejectedPrice(chain, token, timestamp, this.name)) {
      return null
    }

    const coinKey = `${chain}:${token.toLowerCase()}`
    const response = await this.client.getHistorical(timestamp, [coinKey])

    return toHistoricalPrice(response.coins?.[coinKey], (price, time) => this.isUsablePrice(price, time))
  }

  async getBatchHistoricalPrices(
    targets: HistoricalPriceTarget[],
    onResolved?: (entry: HistoricalBatchPrice) => void,
    onSettled?: (targets: HistoricalPriceTarget[], error?: unknown) => void
  ): Promise<HistoricalBatchPrice[]> {
    const currentTimestamp = nowUnix()
    const grouped: Record<string, number[]> = {}
    const targetsByCoin = new Map<string, HistoricalPriceTarget[]>()

    for (const target of targets) {
      if (DEFILLAMA_UNSUPPORTED_CHAINS.has(target.chainId)) continue
      const chain = chainIdToName(target.chainId)
      if (!chain) continue
      if (isRejectedPrice(chain, target.token, target.timestamp, this.name)) {
        onSettled?.([target])
        continue
      }
      const coinKey = `${chain}:${target.token.toLowerCase()}`
      grouped[coinKey] ??= []
      grouped[coinKey].push(target.timestamp)
      const coinTargets = targetsByCoin.get(coinKey) ?? []
      coinTargets.push(target)
      targetsByCoin.set(coinKey, coinTargets)
    }

    const targetsOf = (payload: Record<string, number[]>): HistoricalPriceTarget[] =>
      Object.entries(payload).flatMap(([coinKey, fetchTimestamps]) =>
        (targetsByCoin.get(coinKey) ?? []).filter((target) =>
          fetchTimestamps.includes(toFetchTimestamp(target.timestamp, currentTimestamp))
        )
      )

    const payloads = buildDefiLlamaPayloads(grouped, currentTimestamp)
    const groups: HistoricalBatchPrice[][] = Array.from({ length: payloads.length }, () => [])
    let nextPayload = 0

    // A bounded worker pool keeps a large replay from synchronizing dozens of
    // `/batchHistorical` requests. Each group's result still settles
    // independently, so one 429 or malformed payload does not hide siblings.
    const fetchPayload = async (payload: Record<string, number[]>): Promise<HistoricalBatchPrice[]> => {
      let response: Awaited<ReturnType<DefiLlamaClient['getBatchHistorical']>>
      try {
        response = await this.client.getBatchHistorical(payload)
      } catch (error) {
        // One rate-limited or malformed group must not drop the other groups;
        // their pairs would never be requested at all. Only this group's pairs
        // are reported failed: a sibling group's pairs keep their single-coin
        // retry, and this group's skip a call the same client just failed.
        onSettled?.(targetsOf(payload), error)
        return []
      }

      for (const coinKey of Object.keys(payload)) {
        const value = response.coins?.[coinKey]
        // An omitted coin is a valid successful empty result. A present coin
        // with a malformed shape is a failed provider response and remains
        // retryable through the source chain.
        if (value !== undefined && isMalformedBatchCoin(value)) {
          const error = new ApiError('UNAVAILABLE', 'Malformed DeFiLlama batch coin response')
          onSettled?.(targetsOf(payload), error)
          return []
        }
      }

      const entries: HistoricalBatchPrice[] = []
      for (const [coinKey, fetchTimestamps] of Object.entries(payload)) {
        const samples = (response.coins?.[coinKey]?.prices ?? []).filter((sample) =>
          this.isUsablePrice(sample.price, sample.timestamp)
        )
        const matched = matchPricesToRequests(fetchTimestamps, samples)
        for (const target of targetsByCoin.get(coinKey) ?? []) {
          const fetchTimestamp = toFetchTimestamp(target.timestamp, currentTimestamp)
          if (!fetchTimestamps.includes(fetchTimestamp)) continue
          const sample = matched.get(fetchTimestamp)
          if (!sample) continue
          const entry = {
            target,
            price: {
              price: sample.price,
              timestamp: sample.timestamp,
              symbol: response.coins?.[coinKey]?.symbol ?? null,
              confidence: sample.confidence ?? null
            }
          }
          entries.push(entry)
          onResolved?.(entry)
        }
      }
      // This group answered: its unmatched pairs are a not-found, not a
      // failure, so they keep the single-coin retry even if a sibling group
      // is still running when the batch stage runs out of budget.
      onSettled?.(targetsOf(payload))
      return entries
    }

    const worker = async (): Promise<void> => {
      while (nextPayload < payloads.length) {
        const payloadIndex = nextPayload++
        groups[payloadIndex] = await fetchPayload(payloads[payloadIndex])
      }
    }
    const workerCount = Math.min(DEFI_LLAMA_HISTORICAL_CONCURRENCY, payloads.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return groups.flat()
  }
}

export function createDefiLlamaHistoricalSource(client?: DefiLlamaClient): DefiLlamaHistoricalSource {
  return new DefiLlamaHistoricalSource(client)
}
