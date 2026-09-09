import { buildAdapterPath, classifyError, validatePath } from './engine'
import { evaluatePlan, type PlannedPriceAdapter, type PricePlan } from './plan'
import type {
  MarketPriceResolver,
  PriceResolutionFailureReason,
  RecursivePriceTarget,
  ResolvedPricePath
} from './types'

export function graphKey(target: RecursivePriceTarget): string {
  return `${target.chainId}:${target.token.toLowerCase()}:${target.timestamp}:${target.blockNumber ?? 'none'}`
}
interface Issue {
  adapter: string
  reason: PriceResolutionFailureReason
  error: string
}
export interface GraphRoute {
  adapter: string
  dependencies: {
    key: string
    label: string
    target: RecursivePriceTarget
    cutoff?: 'budget' | 'max-depth'
  }[]
  metadata: Record<string, unknown>
  error?: Issue
}
export interface GraphNode {
  key: string
  target: RecursivePriceTarget
  depth: number
  parents: string[]
  routes: GraphRoute[]
  attempts: Issue[]
  notApplicable: string[]
  market: 'price' | 'missing' | 'error' | 'not-attempted'
  path: ResolvedPricePath | null
  reason: PriceResolutionFailureReason | null
  height: number
}
const order: PriceResolutionFailureReason[] = [
  'retryable',
  'budget',
  'invalid',
  'cycle',
  'max-depth',
  'unsupported'
]
const select = (reasons: PriceResolutionFailureReason[]) =>
  order.find((reason) => reasons.includes(reason)) ?? 'unsupported'

async function each<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  let cursor = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (cursor < items.length) await work(items[cursor++])
    })
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/** Workload-wide graph: discover immutable plans once, fetch each market
 * frontier together, then evaluate captured plans bottom-up without RPC. */
export async function resolveHistoricalGraph(options: {
  roots: RecursivePriceTarget[]
  market: MarketPriceResolver
  prefetch: (targets: RecursivePriceTarget[]) => Promise<void>
  adapters: (target: RecursivePriceTarget) => PlannedPriceAdapter[]
  concurrency?: number
  maxDepth?: number
  maxNodes?: number
  onFrontier?: (depth: number, nodes: GraphNode[]) => void
}) {
  const { roots, market, prefetch, adapters, onFrontier } = options
  const concurrency = options.concurrency ?? 2
  const maxDepth = options.maxDepth ?? 8
  const maxNodes = options.maxNodes ?? Math.max(roots.length, 32_000)
  for (const [name, value] of Object.entries({ concurrency, maxDepth, maxNodes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid graph ${name}`)
  }
  if (roots.length > maxNodes) throw new Error('Graph node budget cannot fit roots')
  const nodes = new Map<string, GraphNode>()
  const plans = new Map<GraphRoute, { plan: PricePlan; adapter: PlannedPriceAdapter }>()
  function add(target: RecursivePriceTarget, depth: number) {
    const key = graphKey(target)
    let node = nodes.get(key)
    if (!node) {
      node = {
        key,
        target,
        depth,
        parents: [],
        routes: [],
        attempts: [],
        notApplicable: [],
        market: 'not-attempted',
        path: null,
        reason: null,
        height: 0
      }
      nodes.set(key, node)
    }
    return node
  }
  let frontier = [...new Set(roots.map((root) => add(root, 0)))]
  while (frontier.length) {
    await prefetch(frontier.map((node) => node.target))
    await each(frontier, concurrency, async (node) => {
      try {
        const path = await market(node.target)
        node.market = path ? 'price' : 'missing'
        if (path) {
          node.path = validatePath(path, node.target)
          return
        }
      } catch (error) {
        node.market = 'error'
        node.attempts.push({ adapter: 'market-price', reason: classifyError(error), error: String(error) })
      }
      // Even when market acquisition fails, discover the on-chain alternatives;
      // the error remains evidence and cannot become a confirmed missing leaf.
      let candidates: PlannedPriceAdapter[]
      try {
        candidates = adapters(node.target)
      } catch (error) {
        node.attempts.push({ adapter: 'graph-discovery', reason: classifyError(error), error: String(error) })
        return
      }
      for (const adapter of candidates) {
        try {
          const plan = await adapter.discover(node.target)
          if (!plan) {
            node.notApplicable.push(adapter.name)
            continue
          }
          const route: GraphRoute = {
            adapter: adapter.name,
            dependencies: plan.dependencies.map((dep) => ({ ...dep, key: graphKey(dep.target) })),
            metadata: plan.metadata
          }
          node.routes.push(route)
          plans.set(route, { plan, adapter })
        } catch (error) {
          node.attempts.push({ adapter: adapter.name, reason: classifyError(error), error: String(error) })
        }
      }
    })
    const next: GraphNode[] = []
    for (const node of frontier) {
      for (const route of node.routes)
        for (const dep of route.dependencies) {
          let child = nodes.get(dep.key)
          if (!child) {
            if (node.depth + 1 >= maxDepth) {
              dep.cutoff = 'max-depth'
              continue
            }
            if (nodes.size >= maxNodes) {
              dep.cutoff = 'budget'
              continue
            }
            child = add(dep.target, node.depth + 1)
            next.push(child)
          }
          if (!child.parents.includes(node.key)) child.parents.push(node.key)
        }
    }
    onFrontier?.(frontier[0].depth, frontier)
    frontier = next
  }

  // Resolve children before parents, revisiting a selected route if a higher
  // priority route becomes available. Selections form an acyclic graph even
  // when the discovered alternatives contain cycles.
  const selected = new Map<string, { index: number; signature: string }>()
  const versions = new Map<string, number>()
  function reaches(from: string, target: string): boolean {
    const pending = [from]
    const seen = new Set<string>()
    while (pending.length) {
      const key = pending.pop()!
      if (key === target) return true
      if (seen.has(key)) continue
      seen.add(key)
      const selection = selected.get(key)
      if (selection)
        pending.push(...nodes.get(key)!.routes[selection.index].dependencies.map((dep) => dep.key))
    }
    return false
  }
  let changed = true
  while (changed) {
    changed = false
    for (const node of [...nodes.values()].reverse()) {
      if (node.market === 'price' && node.path) continue
      for (const [index, route] of node.routes.entries()) {
        if (route.error || route.dependencies.some((dep) => dep.cutoff || !nodes.get(dep.key)?.path)) continue
        if (route.dependencies.some((dep) => reaches(dep.key, node.key))) continue
        const children = route.dependencies.map((dep) => nodes.get(dep.key)!)
        const height = 1 + Math.max(-1, ...children.map((child) => child.height))
        if (node.depth + height >= maxDepth) continue
        const signature = children.map((child) => `${child.key}@${versions.get(child.key) ?? 0}`).join('|')
        const previous = selected.get(node.key)
        if (previous?.index === index && previous.signature === signature) break
        try {
          const captured = plans.get(route)!
          node.path = buildAdapterPath(
            node.target,
            captured.adapter,
            evaluatePlan(
              captured.plan,
              children.map((child) => child.path!)
            )
          )
          node.height = height
          selected.set(node.key, { index, signature })
          versions.set(node.key, (versions.get(node.key) ?? 0) + 1)
          changed = true
          break
        } catch (error) {
          route.error = { adapter: route.adapter, reason: classifyError(error), error: String(error) }
        }
      }
    }
  }
  for (const node of nodes.values())
    if (!node.path)
      for (const route of node.routes) {
        const children = route.dependencies.map((dep) => nodes.get(dep.key))
        if (
          children.every((child) => child?.path) &&
          node.depth + 1 + Math.max(-1, ...children.map((child) => child!.height)) >= maxDepth
        ) {
          route.error ??= {
            adapter: route.adapter,
            reason: 'max-depth',
            error: 'Derived path exceeds graph depth limit'
          }
        }
      }

  // Peel leaves to identify unresolved nodes that depend on a cycle. This
  // is iterative so a large shared graph cannot overflow the JavaScript stack.
  const unresolved = [...nodes.values()].filter((node) => !node.path)
  const remaining = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const node of unresolved) {
    const children = new Set(
      node.routes.flatMap((route) =>
        route.error
          ? []
          : route.dependencies.filter((dep) => !dep.cutoff && !nodes.get(dep.key)?.path).map((dep) => dep.key)
      )
    )
    remaining.set(node.key, children)
    for (const key of children) {
      if (!dependents.has(key)) dependents.set(key, new Set())
      dependents.get(key)!.add(node.key)
    }
  }
  const leaves = [...remaining].filter(([, children]) => !children.size).map(([key]) => key)
  for (let i = 0; i < leaves.length; i++) {
    for (const parent of dependents.get(leaves[i]) ?? []) {
      const children = remaining.get(parent)!
      children.delete(leaves[i])
      if (!children.size) leaves.push(parent)
    }
  }
  for (const node of unresolved) {
    const reasons = node.attempts.map((attempt) => attempt.reason)
    for (const route of node.routes) {
      if (route.error) reasons.push(route.error.reason)
      for (const dep of route.dependencies) if (dep.cutoff) reasons.push(dep.cutoff)
    }
    if (remaining.get(node.key)!.size) reasons.push('cycle')
    node.reason = select(reasons)
  }
  changed = true
  while (changed) {
    changed = false
    for (const node of unresolved) {
      const reasons = [node.reason!]
      for (const route of node.routes)
        for (const dep of route.dependencies) {
          const child = nodes.get(dep.key)
          if (child?.reason) reasons.push(child.reason)
        }
      const reason = select(reasons)
      if (reason !== node.reason) {
        node.reason = reason
        changed = true
      }
    }
  }
  return { roots: roots.map(graphKey), nodes: [...nodes.values()] }
}
