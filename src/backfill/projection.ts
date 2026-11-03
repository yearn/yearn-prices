import type { GraphNode } from '../sources/onchain/graph'
import { dependencyRoute } from './investigation'

export interface BackfillTargetOutcome {
  target: { chainId: number; token: string; eodTimestamp: number }
  status: string
  [key: string]: unknown
}

const REMAINING_OUTCOME_STATUSES = new Set(['unresolved', 'rejected', 'rejected_implausible'])
const RESOLVED_OUTCOME_STATUSES = new Set([
  'skipped_existing',
  'inserted',
  'would-insert',
  'skipped_concurrent_existing'
])

/** Reconcile one authoritative final outcome for every normalized target. */
export function reconcileTargetOutcomes(outcomes: BackfillTargetOutcome[], targetCount: number) {
  if (!Number.isSafeInteger(targetCount) || targetCount < 0) throw new Error('Invalid normalized target count')
  const seen = new Set<string>()
  const remaining: BackfillTargetOutcome[] = []
  let alreadyStored = 0
  let insertedOrProjected = 0
  let concurrentExisting = 0
  let unresolved = 0
  let rejected = 0
  let rejectedImplausible = 0

  for (const outcome of outcomes) {
    const { chainId, token, eodTimestamp } = outcome.target ?? ({} as BackfillTargetOutcome['target'])
    if (!Number.isSafeInteger(chainId) || typeof token !== 'string' || !Number.isSafeInteger(eodTimestamp))
      throw new Error('Malformed final target outcome')
    const key = `${chainId}:${token.toLowerCase()}:${eodTimestamp}`
    if (seen.has(key)) throw new Error('Duplicate final target outcome')
    seen.add(key)

    if (outcome.status === 'skipped_existing') alreadyStored++
    else if (outcome.status === 'inserted' || outcome.status === 'would-insert') insertedOrProjected++
    else if (outcome.status === 'skipped_concurrent_existing') concurrentExisting++
    else if (REMAINING_OUTCOME_STATUSES.has(outcome.status)) {
      remaining.push(outcome)
      if (outcome.status === 'unresolved') unresolved++
      else if (outcome.status === 'rejected') rejected++
      else rejectedImplausible++
    } else if (!RESOLVED_OUTCOME_STATUSES.has(outcome.status)) {
      throw new Error(`Unknown final target outcome status: ${outcome.status}`)
    }
  }

  if (outcomes.length !== targetCount)
    throw new Error(`Final target outcomes do not reconcile: expected ${targetCount}, found ${outcomes.length}`)

  return {
    targetCount,
    alreadyStored,
    insertedOrProjected,
    concurrentExisting,
    remaining,
    remainingOriginalTargets: remaining.length,
    unresolved,
    rejected,
    rejectedImplausible
  }
}

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
