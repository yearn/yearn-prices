import { DefiLlamaClient } from '../../clients/defillama'
import { chainIdToName } from '../../utils/chains'
import { nowUnix, toFetchTimestamp } from '../../utils/time'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../types'
import { buildDefiLlamaPayloads } from './batch'
import { toHistoricalPrice } from './coin'
import { matchPricesToRequests } from './match'

export class DefiLlamaHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'defillama'
  readonly priority = 10

  constructor(private readonly client: DefiLlamaClient = new DefiLlamaClient()) {
    super()
  }

  supports(chainId: number): boolean {
    return chainIdToName(chainId) !== undefined
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
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
    onResolved?: (entry: HistoricalBatchPrice) => void
  ): Promise<HistoricalBatchPrice[]> {
    const currentTimestamp = nowUnix()
    const grouped: Record<string, number[]> = {}
    const targetsByCoin = new Map<string, HistoricalPriceTarget[]>()

    for (const target of targets) {
      const chain = chainIdToName(target.chainId)
      if (!chain) continue
      const coinKey = `${chain}:${target.token.toLowerCase()}`
      grouped[coinKey] ??= []
      grouped[coinKey].push(target.timestamp)
      const coinTargets = targetsByCoin.get(coinKey) ?? []
      coinTargets.push(target)
      targetsByCoin.set(coinKey, coinTargets)
    }

    const resolved: HistoricalBatchPrice[] = []
    let groupError: unknown
    for (const payload of buildDefiLlamaPayloads(grouped, currentTimestamp)) {
      let response: Awaited<ReturnType<DefiLlamaClient['getBatchHistorical']>>
      try {
        response = await this.client.getBatchHistorical(payload)
      } catch (error) {
        // One rate-limited or malformed group must not cancel the groups after
        // it; their pairs would never be requested at all.
        groupError ??= error
        continue
      }
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
          resolved.push(entry)
          onResolved?.(entry)
        }
      }
    }
    if (resolved.length === 0 && groupError !== undefined) {
      throw groupError
    }
    return resolved
  }
}

export function createDefiLlamaHistoricalSource(client?: DefiLlamaClient): DefiLlamaHistoricalSource {
  return new DefiLlamaHistoricalSource(client)
}
