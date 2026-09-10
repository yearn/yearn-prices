import { appendFileSync, writeFileSync } from 'node:fs'
import { getChainClient } from '../../src/clients/rpc'
import { HistoricalSourceRegistry } from '../../src/registries/historical'
import { createMarketPriceResolver } from '../../src/registries/market-price'
import { createOnchainPriceAdapters } from '../../src/sources/onchain/adapters'
import { graphKey, resolveHistoricalGraph, type GraphNode } from '../../src/sources/onchain/graph'
import { createReadBudget } from '../../src/sources/onchain/read-budget'
import type { RecursivePriceTarget, ResolvedPricePath } from '../../src/sources/onchain/types'
import type { HistoricalPriceSource } from '../../src/sources/types'
import { chainIdToName } from '../../src/utils/chains'
import type { BatchedHistoricalClient } from './batched-historical-client'

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
}) {
  const { targets, sources, provider, out, concurrency, maxNodes, clean } = options
  const marketAttempts = new Map<string, unknown[]>()
  const budgets = new Map<string, ReturnType<typeof createReadBudget>>()
  const json = (value: unknown) =>
    JSON.stringify(value, (_, value) => (typeof value === 'bigint' ? value.toString() : value))
  const graph = await resolveHistoricalGraph({
    roots: targets,
    concurrency,
    maxNodes,
    prefetch: async (targets) => {
      await options.stored?.prefetch(targets)
      if (provider)
        await provider.prefetch(
          targets
            .filter((target) => !options.stored?.get(target))
            .map((target) => ({
              coin: `${chainIdToName(target.chainId)}:${target.token.toLowerCase()}`,
              timestamp: target.timestamp!
            }))
        )
    },
    market: async (target) => {
      const stored = options.stored?.get(target)
      if (stored) return stored
      const attempts: unknown[] = []
      marketAttempts.set(graphKey(target), attempts)
      const traced = sources.map((source) => ({
        name: source.name,
        priority: source.priority,
        supports: (chainId: number) => source.supports(chainId),
        async getHistoricalPrice(chainId: number, token: string, timestamp: number) {
          try {
            const quote = await source.getHistoricalPrice(chainId, token, timestamp)
            attempts.push({ chainId, token, timestamp, source: source.name, quote })
            return quote
          } catch (error) {
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
      )(target)
    },
    adapters: (target) => {
      const client = getChainClient(target.chainId)
      if (!client) throw new Error(`RPC_URL_${target.chainId} is not configured`)
      const budget = createReadBudget(400)
      budgets.set(graphKey(target), budget)
      const metered = budget.meter(client)
      return createOnchainPriceAdapters({
        clientForChain: (chainId) => (chainId === target.chainId ? metered : null),
        blockContextCache: new Map()
      })
    },
    onFrontier(depth, nodes) {
      appendFileSync(
        out,
        `${json({ type: 'graph-frontier', depth, nodes: nodes.length, batching: provider?.stats ?? null })}\n`
      )
      console.log(
        json({ stage: 'graph-frontier', depth, nodes: nodes.length, batching: provider?.stats ?? null })
      )
    }
  })
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
  const evidence = {
    ...graph,
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
    onchainReads: [...budgets.values()].reduce((sum, budget) => sum + budget.spent, 0),
    evidence: `${out}.graph.json`
  }
}
