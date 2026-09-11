import type { GraphNode } from '../sources/onchain/graph'

/** Exclude only a discovered route blocked by missing prices. Errors, cycles,
 * cutoffs and absent routes still need their own investigation. */
export function dependencyRoute(node: GraphNode, nodes: Map<string, GraphNode>) {
  if (node.path || node.reason !== 'unsupported') return null
  const route = node.routes.find(
    (route) =>
      !route.error &&
      route.dependencies.length > 0 &&
      route.dependencies.every(
        (dep) =>
          !dep.cutoff &&
          nodes.has(dep.key) &&
          (nodes.get(dep.key)!.path || nodes.get(dep.key)!.reason === 'unsupported')
      )
  )
  if (!route) return null
  const missing = route.dependencies.filter((dep) => !nodes.get(dep.key)!.path)
  if (!missing.length) return null
  return route
}

export function dependencyBlockers(node: GraphNode, nodes: Map<string, GraphNode>) {
  const route = dependencyRoute(node, nodes)
  if (!route) return null
  return route.dependencies
    .filter((dep) => !nodes.get(dep.key)!.path)
    .map((dep) => ({
      chainId: dep.target.chainId,
      token: dep.target.token.toLowerCase(),
      timestamp: dep.target.timestamp!
    }))
}

export function needsOwnPricing(observation: { status: string; pricingNeed?: string }): boolean {
  return observation.status === 'unresolved' && observation.pricingNeed !== 'dependency'
}
