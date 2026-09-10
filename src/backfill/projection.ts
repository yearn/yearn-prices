import type { GraphNode } from '../sources/onchain/graph'
import { dependencyRoute } from './investigation'

/** Trace only roots that the completed backfill leaves unresolved. Unused
 * graph branches and older inventory failures do not belong in the forecast. */
export function remainingPriceProjection(nodes: GraphNode[], remainingRoots: string[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const assets = new Map<string, { chainId: number; token: string; dates: Map<number, Set<string>> }>()
  const dependentAssets = new Set<string>()
  for (const root of remainingRoots) {
    const seen = new Set<string>()
    function visit(key: string) {
      if (seen.has(key)) throw new Error('Cyclic dependency in remaining-price projection')
      const node = byKey.get(key)
      if (!node || node.target.timestamp == null) throw new Error('Missing historical projection node')
      if (node.path && key !== root) return
      seen.add(key)
      const route = dependencyRoute(node, byKey)
      const assetKey = node.target.chainId + ':' + node.target.token.toLowerCase()
      if (route) {
        dependentAssets.add(assetKey)
        for (const dependency of route.dependencies) if (!byKey.get(dependency.key)?.path) visit(dependency.key)
      } else {
        const asset = assets.get(assetKey) ?? {
          chainId: node.target.chainId,
          token: node.target.token.toLowerCase(),
          dates: new Map<number, Set<string>>()
        }
        const affected = asset.dates.get(node.target.timestamp) ?? new Set<string>()
        affected.add(root)
        asset.dates.set(node.target.timestamp, affected)
        assets.set(assetKey, asset)
      }
      seen.delete(key)
    }
    visit(root)
  }
  return {
    remainingRootCount: remainingRoots.length,
    dependencyOnlyAssetCount: [...dependentAssets].filter((key) => !assets.has(key)).length,
    assets: [...assets.values()]
      .sort((a, b) => a.chainId - b.chainId || a.token.localeCompare(b.token))
      .map((asset) => ({
        chainId: asset.chainId,
        token: asset.token,
        dates: [...asset.dates]
          .sort(([a], [b]) => a - b)
          .map(([timestamp, roots]) => ({ timestamp, affectedRoots: [...roots].sort() })),
        affectedRootCount: new Set([...asset.dates.values()].flatMap((roots) => [...roots])).size
      }))
  }
}

/** Positions describe remaining gaps relative to the known historical range;
 * an observation found outside this backfill never marks a gap resolved here. */
export function remainingGapPositions(dates: number[], first: number | null, last: number | null) {
  const groups: Record<string, number[]> = {}
  for (const date of [...new Set(dates)].sort((a, b) => a - b)) {
    const position =
      first == null || last == null ? 'no-known-history' : date < first ? 'before' : date > last ? 'after' : 'interior'
    groups[position] ??= []
    groups[position].push(date)
  }
  return groups
}
