import type { GraphNode } from '../sources/onchain/graph'
import { SOURCE_PRIORITY } from '../types'
import { MAXIMUM_ACCEPTED_OFFSET_SECONDS } from './constants'
import type { FinalizationResolution } from './finalize'
import type { NormalizedTarget } from './manifest'

/** Validate every selected graph dependency, not just the root's minimum
 * observation timestamp (which can hide a late or stale constituent). */
export function validateGraphResolution(
  root: GraphNode,
  target: NormalizedTarget,
  nodes: Map<string, GraphNode>
): FinalizationResolution {
  if (
    root.target.chainId !== target.chainId ||
    root.target.token.toLowerCase() !== target.tokenLowercase ||
    root.target.timestamp !== target.eodTimestamp
  )
    throw new Error('Graph root target mismatch')
  const visiting = new Set<string>()
  const validated = new Set<string>()
  function visit(node: GraphNode) {
    if (visiting.has(node.key)) throw new Error('Selected graph contains a cycle')
    if (validated.has(node.key)) return
    visiting.add(node.key)
    const path = node.path
    if (
      !path ||
      !Number.isFinite(path.priceUsd) ||
      path.priceUsd <= 0 ||
      path.chainId !== node.target.chainId ||
      path.token.toLowerCase() !== node.target.token.toLowerCase() ||
      path.requestedTimestamp !== target.eodTimestamp ||
      node.target.timestamp !== target.eodTimestamp ||
      !SOURCE_PRIORITY.includes(path.source)
    )
      throw new Error('Invalid graph price identity or value')
    if (
      !Number.isSafeInteger(path.observedTimestamp) ||
      Math.abs(path.observedTimestamp - target.eodTimestamp) > MAXIMUM_ACCEPTED_OFFSET_SECONDS
    )
      throw new Error('Graph observation outside 6-hour matching window')
    if (node.market !== 'price') {
      const block = path.metadata.block as
        | { number?: number; timestamp?: number; requestedTimestamp?: number }
        | undefined
      if (
        !block ||
        !Number.isSafeInteger(block.number) ||
        block.number !== path.blockNumber ||
        !Number.isSafeInteger(block.timestamp) ||
        block.requestedTimestamp !== target.eodTimestamp ||
        block.timestamp! > target.eodTimestamp ||
        target.eodTimestamp - block.timestamp! > MAXIMUM_ACCEPTED_OFFSET_SECONDS ||
        (node.target.blockNumber != null && block.number !== node.target.blockNumber)
      )
        throw new Error('Invalid historical block evidence')
      const route = node.routes.find((route) => route.adapter === path.adapter && !route.error)
      if (!route || route.dependencies.length !== path.inputs.length) throw new Error('Missing selected route evidence')
      for (const [index, dependency] of route.dependencies.entries()) {
        const child = nodes.get(dependency.key)
        if (dependency.cutoff || !child?.path) throw new Error('Incomplete selected dependency')
        const input = path.inputs[index]
        if (
          input.chainId !== child.target.chainId ||
          input.token.toLowerCase() !== child.target.token.toLowerCase() ||
          input.priceUsd !== child.path.priceUsd ||
          input.observedTimestamp !== child.path.observedTimestamp ||
          input.adapter !== child.path.adapter ||
          input.source !== child.path.source
        )
          throw new Error('Selected dependency evidence mismatch')
        visit(child)
      }
    }
    visiting.delete(node.key)
    validated.add(node.key)
  }
  visit(root)
  const path = root.path!
  return { price: path.priceUsd, symbol: path.symbol, confidence: path.confidence, source: path.source }
}
