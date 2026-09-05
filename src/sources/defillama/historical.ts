import { DefiLlamaClient } from '../../clients/defillama'
import { chainIdToName } from '../../utils/chains'
import { nowUnix, toFetchTimestamp } from '../../utils/time'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../types'
import { buildDefiLlamaPayloads } from './batch'
import { toHistoricalPrice } from './coin'
import { matchPricesToRequests } from './match'

export const DEFILLAMA_UNSUPPORTED_CHAINS: ReadonlySet<number> = new Set([4663])

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
    if (!chain) {
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

    // Groups run concurrently: fetched one after another, a hung group burns
    // the route's resolution budget and the single-coin fallback never runs.
    const groups = await Promise.all(
      buildDefiLlamaPayloads(grouped, currentTimestamp).map(async (payload) => {
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
      })
    )
    return groups.flat()
  }
}

export function createDefiLlamaHistoricalSource(client?: DefiLlamaClient): DefiLlamaHistoricalSource {
  return new DefiLlamaHistoricalSource(client)
}
