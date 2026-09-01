import { DefiLlamaClient } from '../clients/defillama'
import { getChainClient } from '../clients/rpc'
import { ApiError } from '../http'
import {
  createChainlinkHistoricalSource,
  createDefiLlamaAliasHistoricalSource,
  createDefiLlamaHistoricalSource
} from '../sources'
import { createOnchainHistoricalSource } from '../sources/onchain'
import type {
  HistoricalBatchPrice,
  HistoricalPrice,
  HistoricalPriceSource,
  HistoricalPriceTarget
} from '../sources/types'
import type { Env } from '../types'

import { createMarketPriceResolver } from './market-price'
import { SourceRegistry } from './source-registry'

/**
 * Prices an on-chain adapter's child tokens with the market sources only. It
 * never sees the on-chain source, so recursion cannot loop back into itself.
 */
function marketPriceResolver(marketSources: HistoricalPriceSource[]) {
  const registry = new HistoricalSourceRegistry(marketSources)
  return createMarketPriceResolver(
    marketSources,
    (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
    { requireTimestamp: true }
  )
}

export function createHistoricalSources(env?: Env): HistoricalPriceSource[] {
  // Leave enough room inside the route's five-second resolution budget to
  // return already-completed partial results when the provider hangs.
  const client = new DefiLlamaClient(undefined, undefined, { timeoutMs: 4_000 })
  const marketSources = [
    createDefiLlamaHistoricalSource(client),
    createChainlinkHistoricalSource({ env }),
    createDefiLlamaAliasHistoricalSource(client)
  ]

  return [
    ...marketSources,
    createOnchainHistoricalSource({
      marketPrice: marketPriceResolver(marketSources),
      env,
      clientForChain: (chainId) => getChainClient(chainId, env)
    })
  ]
}

export class HistoricalSourceRegistry extends SourceRegistry<HistoricalPriceSource, [timestamp: number]> {
  constructor(sources: HistoricalPriceSource[]) {
    super(
      sources,
      'historical',
      (source, chainId, token, timestamp) => source.getHistoricalPrice(chainId, token, timestamp),
      'No historical price available for this token'
    )
  }

  override resolve(chainId: number, token: string, timestamp: number): Promise<HistoricalPrice> {
    return super.resolve(chainId, token, timestamp)
  }

  /**
   * Uses a provider-native batch method when available, then runs the remaining
   * sources only for targets the batch did not resolve. Settlements are emitted
   * as they happen so a route deadline can retain completed partial results.
   */
  async resolveBatch(
    targets: HistoricalPriceTarget[],
    onSettled: (target: HistoricalPriceTarget, result: PromiseSettledResult<HistoricalPrice>) => void
  ): Promise<void> {
    const firstSource = this.all()[0]
    const batchSource = typeof firstSource?.getBatchHistoricalPrices === 'function' ? firstSource : undefined
    if (!batchSource?.getBatchHistoricalPrices) {
      await Promise.all(
        targets.map(async (target) => {
          try {
            onSettled(target, {
              status: 'fulfilled',
              value: await this.resolve(target.chainId, target.token, target.timestamp)
            })
          } catch (reason) {
            onSettled(target, { status: 'rejected', reason })
          }
        })
      )
      return
    }

    const key = (target: HistoricalPriceTarget) => `${target.chainId}:${target.token.toLowerCase()}:${target.timestamp}`
    const pending = new Map(targets.map((target) => [key(target), target]))
    const batchErrors = new Map<string, unknown>()
    const batchTargets = targets.filter((target) => batchSource.supports(target.chainId))
    const settleDirect = (entry: HistoricalBatchPrice) => {
      const entryKey = key(entry.target)
      const target = pending.get(entryKey)
      if (!target) return
      pending.delete(entryKey)
      onSettled(target, { status: 'fulfilled', value: { ...entry.price, source: batchSource.name } })
    }

    try {
      const direct = await batchSource.getBatchHistoricalPrices(batchTargets, settleDirect)
      for (const entry of direct) {
        settleDirect(entry)
      }
    } catch (error) {
      for (const target of batchTargets) {
        batchErrors.set(key(target), error)
      }
    }

    const fallback = new HistoricalSourceRegistry(this.all().filter((source) => source !== batchSource))
    await Promise.all(
      [...pending.values()].map(async (target) => {
        try {
          onSettled(target, {
            status: 'fulfilled',
            value: await fallback.resolve(target.chainId, target.token, target.timestamp)
          })
        } catch (reason) {
          const batchError = batchErrors.get(key(target))
          const finalReason =
            reason instanceof ApiError && reason.code === 'NOT_FOUND' && batchError ? batchError : reason
          onSettled(target, { status: 'rejected', reason: finalReason })
        }
      })
    )
  }
}
