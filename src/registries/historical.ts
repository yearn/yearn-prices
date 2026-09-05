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
  // Per-attempt timeout only; 5xx responses still retry with backoff, so the
  // batch stage is capped separately by BATCH_STAGE_BUDGET_MS. Retrying every
  // member of a rate-limited batch in lockstep amplifies the provider burst;
  // offline jobs keep their retry policy. No route calls this registry today;
  // the budgets bound any future request-path caller.
  const client = new DefiLlamaClient(undefined, undefined, { timeoutMs: 2_500, retryRateLimits: false })
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

/**
 * Cap on the provider batch stage. A slow or retrying provider batch call must
 * not consume a caller's whole budget: the rest of the source chain still needs
 * time to price the pairs the batch never returned.
 */
const BATCH_STAGE_BUDGET_MS = 2_500

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
   * Uses a provider-native batch method when available, then runs the source
   * chain for targets the batch did not resolve. A pair the batch matcher drops
   * is still tried against the batch source's single lookup; a pair whose own
   * payload group failed, or whose group never answered before the batch stage
   * ran out of budget, skips that source, since the same client would fail again.
   * Settlements are emitted as they happen so a route deadline can retain
   * completed partial results.
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
    let batchStageOpen = true
    const settleDirect = (entry: HistoricalBatchPrice) => {
      if (!batchStageOpen) return
      const entryKey = key(entry.target)
      const target = pending.get(entryKey)
      if (!target) return
      pending.delete(entryKey)
      onSettled(target, { status: 'fulfilled', value: { ...entry.price, source: batchSource.name } })
    }
    const answered = new Set<string>()
    const markSettled = (settledTargets: HistoricalPriceTarget[], error?: unknown) => {
      if (!batchStageOpen) return
      for (const target of settledTargets) {
        if (error === undefined) answered.add(key(target))
        else batchErrors.set(key(target), error)
      }
    }

    const batchStage = batchSource
      .getBatchHistoricalPrices(batchTargets, settleDirect, markSettled)
      .then((direct) => {
        for (const entry of direct) {
          settleDirect(entry)
        }
      })
      .catch((error: unknown) => markSettled(batchTargets, error))

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      batchStage.then(() => false),
      new Promise<true>((resolve) => {
        timeoutId = setTimeout(() => resolve(true), BATCH_STAGE_BUDGET_MS)
      })
    ])
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (timedOut) {
      // Only pairs whose own group never answered: a group that came back 200
      // with no match keeps its single-coin retry, and targets the batch never
      // covered keep their own not-found.
      markSettled(
        batchTargets.filter((target) => pending.has(key(target)) && !answered.has(key(target))),
        new ApiError('UNAVAILABLE', 'defillama batch stage exceeded its budget')
      )
    }
    batchStageOpen = false

    await Promise.all(
      [...pending.values()].map(async (target) => {
        const batchError = batchErrors.get(key(target))
        try {
          onSettled(target, {
            status: 'fulfilled',
            value: await this.resolveSkipping(
              batchError ? batchSource.name : undefined,
              target.chainId,
              target.token,
              target.timestamp
            )
          })
        } catch (reason) {
          const finalReason =
            reason instanceof ApiError && reason.code === 'NOT_FOUND' && batchError ? batchError : reason
          onSettled(target, { status: 'rejected', reason: finalReason })
        }
      })
    )
  }
}
