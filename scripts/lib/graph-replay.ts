import { appendFileSync, writeFileSync } from 'node:fs'
import { getChainClient } from '../../src/clients/rpc'
import { HistoricalSourceRegistry } from '../../src/registries/historical'
import { createMarketPriceResolver } from '../../src/registries/market-price'
import { createOnchainPriceAdapters } from '../../src/sources/onchain/adapters'
import { HistoricalBlockCache } from '../../src/sources/onchain/context'
import {
  type GraphNode,
  graphCacheKey,
  graphKey,
  HistoricalGraphCache,
  resolveHistoricalGraph
} from '../../src/sources/onchain/graph'
import { createReadBudget } from '../../src/sources/onchain/read-budget'
import type { RecursivePriceTarget, ResolvedPricePath } from '../../src/sources/onchain/types'
import type { HistoricalPriceSource } from '../../src/sources/types'
import { chainIdToName } from '../../src/utils/chains'
import type { BatchedHistoricalClient } from './batched-historical-client'

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** One bounded session per repair run, never shared between requests or configurations. */
export function createGraphReplaySession() {
  return {
    graph: new HistoricalGraphCache(),
    blocks: new HistoricalBlockCache(),
    adapters: new Map<
      string,
      {
        adapters: ReturnType<typeof createOnchainPriceAdapters>
        budget: ReturnType<typeof createReadBudget>
      }
    >(),
    onchainReads: 0
  }
}
export type GraphReplaySession = ReturnType<typeof createGraphReplaySession>

export async function replayGraph(options: {
  targets: RecursivePriceTarget[]
  stored?: {
    prefetch(targets: RecursivePriceTarget[]): Promise<void>
    get(target: RecursivePriceTarget): ResolvedPricePath | null
  }
  sources: HistoricalPriceSource[]
  provider: BatchedHistoricalClient | null
  out: string
  concurrency: number
  maxNodes: number
  clean: (message: string) => string
  signal?: AbortSignal
  session?: GraphReplaySession
}) {
  const { targets, sources, provider, out, concurrency, maxNodes, clean, signal } = options
  throwIfAborted(signal)
  const session = options.session ?? createGraphReplaySession()
  const readsBefore = session.onchainReads
  const marketAttempts = new Map<string, unknown[]>()
  const budgets = new Map<string, ReturnType<typeof createReadBudget>>()
  let lastProgress = 0
  const json = (value: unknown) =>
    JSON.stringify(value, (_, value) => (typeof value === 'bigint' ? value.toString() : value))
  const graph = await resolveHistoricalGraph({
    roots: signal ? targets.map((target) => ({ ...target, signal })) : targets,
    concurrency,
    maxNodes,
    cache: session.graph,
    prefetch: async (targets) => {
      throwIfAborted(signal)
      await options.stored?.prefetch(targets)
      throwIfAborted(signal)
      if (provider) {
        await provider.prefetch(
          targets
            .filter((target) => !options.stored?.get(target))
            .map((target) => ({
              coin: `${chainIdToName(target.chainId)}:${target.token.toLowerCase()}`,
              timestamp: target.timestamp!
            }))
        )
        throwIfAborted(signal)
      }
    },
    market: async (target) => {
      throwIfAborted(signal)
      const stored = options.stored?.get(target)
      if (stored) return stored
      const attempts: unknown[] = []
      marketAttempts.set(graphKey(target), attempts)
      const traced = sources.map((source) => ({
        name: source.name,
        priority: source.priority,
        supports: (chainId: number) => source.supports(chainId),
        async getHistoricalPrice(chainId: number, token: string, timestamp: number) {
          throwIfAborted(signal)
          try {
            const quote = await source.getHistoricalPrice(chainId, token, timestamp)
            throwIfAborted(signal)
            attempts.push({ chainId, token, timestamp, source: source.name, quote })
            return quote
          } catch (error) {
            throwIfAborted(signal)
            attempts.push({ chainId, token, timestamp, source: source.name, error: clean(String(error)) })
            throw error
          }
        }
      }))
      const registry = new HistoricalSourceRegistry(traced)
      return createMarketPriceResolver(
        traced,
        (chain, token, timestamp) => registry.resolve(chain, token, timestamp!),
        { requireTimestamp: true }
      )(target).then((result) => {
        throwIfAborted(signal)
        return result
      })
    },
    adapters: (target) => {
      throwIfAborted(signal)
      const client = getChainClient(target.chainId)
      if (!client) throw new Error(`RPC_URL_${target.chainId} is not configured`)
      const key = graphCacheKey(target)
      const cached = target.timestamp == null ? undefined : session.adapters.get(key)
      if (cached) {
        budgets.set(graphKey(target), cached.budget)
        return cached.adapters
      }
      const budget = createReadBudget(400, () => {
        session.onchainReads += 1
      })
      budgets.set(graphKey(target), budget)
      const metered = budget.meter(client)
      const adapters = createOnchainPriceAdapters({
        clientForChain: (chainId) => (chainId === target.chainId ? metered : null),
        blockContextCache: new Map(),
        historicalBlocks: session.blocks
      })
      if (target.timestamp != null) session.adapters.set(key, { adapters, budget })
      if (session.adapters.size > 32_000) session.adapters.delete(session.adapters.keys().next().value!)
      throwIfAborted(signal)
      return adapters
    },
    onProgress(depth, stage, done, total) {
      throwIfAborted(signal)
      const now = Date.now()
      if (stage === 'resolved' && done < total && now - lastProgress < 15_000) return
      lastProgress = now
      console.log(json({ stage: `graph-${stage}`, depth, done, total, batching: provider?.stats ?? null }))
      throwIfAborted(signal)
    },
    onFrontier(depth, nodes) {
      throwIfAborted(signal)
      appendFileSync(
        out,
        `${json({ type: 'graph-frontier', depth, nodes: nodes.length, batching: provider?.stats ?? null })}\n`
      )
      console.log(json({ stage: 'graph-frontier', depth, nodes: nodes.length, batching: provider?.stats ?? null }))
      throwIfAborted(signal)
    }
  })
  throwIfAborted(signal)
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]))
  for (const node of graph.nodes) {
    for (const attempt of node.attempts) attempt.error = clean(attempt.error)
    for (const route of node.routes) if (route.error) route.error.error = clean(route.error.error)
  }
  function failure(node: GraphNode): unknown {
    return {
      token: node.target.token,
      reason: node.reason,
      attempts: [
        ...node.attempts,
        ...node.routes.flatMap<unknown>((route) =>
          route.error
            ? [route.error]
            : route.dependencies
                .filter((dep) => dep.cutoff || !byKey.get(dep.key)?.path)
                .map((dep) => ({
                  adapter: route.adapter,
                  reason: dep.cutoff ?? byKey.get(dep.key)?.reason,
                  error: `${dep.label} unavailable; see graph node ${dep.key}`,
                  dependency: dep.cutoff
                    ? { token: dep.target.token, reason: dep.cutoff, attempts: [] }
                    : {
                        token: dep.target.token,
                        reason: byKey.get(dep.key)!.reason,
                        attempts: [],
                        graphKey: dep.key
                      }
                }))
        )
      ]
    }
  }
  const counts: Record<string, number> = {}
  for (const key of graph.roots) {
    const node = byKey.get(key)!
    const status = node.path
      ? node.market === 'price'
        ? 'candidate-market'
        : 'candidate-adapter'
      : !getChainClient(node.target.chainId)
        ? 'missing-rpc'
        : node.reason!
    counts[status] = (counts[status] ?? 0) + 1
    appendFileSync(
      out,
      `${json({
        type: 'target',
        target: node.target,
        status,
        path: node.path,
        failure: node.path ? null : failure(node),
        graphKey: node.key,
        marketAttempts: marketAttempts.get(key) ?? [],
        adapterAttempts: node.attempts,
        onchainReads: budgets.get(key)?.spent ?? 0
      })}\n`
    )
  }
  const cacheStats = {
    blockNumbers: session.blocks.numbers.stats,
    blockTimestamps: session.blocks.timestamps.stats,
    plans: session.graph.plans.stats,
    market: session.graph.market.stats,
    derivations: session.graph.derivations.stats,
    runOnchainReads: session.onchainReads
  }
  console.log(json({ stage: 'graph-cache', ...cacheStats }))
  const evidence = {
    ...graph,
    cacheStats,
    nodes: graph.nodes.map((node) => ({
      ...node,
      marketAttempts: marketAttempts.get(node.key) ?? [],
      onchainReads: budgets.get(node.key)?.spent ?? 0
    }))
  }
  writeFileSync(`${out}.graph.json`, `${json(evidence)}\n`, { flag: 'wx' })
  return {
    counts,
    nodes: graph.nodes.length,
    edges: graph.nodes.reduce(
      (sum, node) => sum + node.routes.reduce((n, route) => n + route.dependencies.length, 0),
      0
    ),
    onchainReads: session.onchainReads - readsBefore,
    cacheStats,
    evidence: `${out}.graph.json`
  }
}
