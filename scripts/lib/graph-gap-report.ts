import { validateGraphResolution } from '../../src/backfill/graph-validation'
import type { ParsedManifest } from '../../src/backfill/manifest'
import type { GraphNode } from '../../src/sources/onchain/graph'

/** Only application-authored, constrained messages enter a shareable report.
 * RPC/provider exceptions can contain credentials, request bodies and URLs. */
export function safePricingFailure(message: string): string | null {
  const value = message.replace(/^(?:InvalidPricingError|Error): /, '')
  const patterns = [
    /^Curve coin \d+ balance \d+ exceeds pool holdings \d+$/,
    /^Curve coin \d+ swap quote into anchor \d+ is zero$/,
    /^Curve coin \d+ (?:has no supported swap quote into anchor \d+|full-reserve swap into anchor \d+ is unavailable|swap quote produced an invalid price)$/,
    /^Curve coin \d+ executable value [\deE.+-]+ is below [\deE.+-]+ of marked value [\deE.+-]+$/,
    /^Curve derived value [\deE.+-]+ exceeds anchor bound [\deE.+-]+$/,
    /^Curve (?:LP has zero total supply|pool has zero reserves) at the requested block$/,
    /^Curve pool has no positive priced anchor reserve$/,
    /^Stable pool anchor liquidity \$[\deE.+-]+ is below \$\d+$/,
    /^Stable pool (?:factory registration mismatch|reserves exceed token holdings|swap quote has no executable output|derived reserve fails executable-value bound|swaps are paused at the requested block)$/,
    /^Curve oracle pool 0x[a-fA-F0-9]{40} (?:holds \$\d+ of the quote coin, below \$\d+|reads at the stableswap EMA cap|balance is unreadable)$/,
    /^Pool NAV (?:denominator must be positive|produced an invalid price)$/,
    /^Compound v3 wrapper (?:identity or decimals mismatch|redemption is paused|has insufficient principal backing|has insufficient base redemption liquidity)$/,
    /^Plan could not derive missing inputs$/
  ]
  return patterns.some((pattern) => pattern.test(value)) ? value : null
}

export function graphGapReport(graph: { roots: string[]; nodes: GraphNode[] }, manifest: ParsedManifest) {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  if (graph.roots.length !== manifest.targets.length) throw new Error('Gap report root count mismatch')
  const targets = manifest.targets.map((target, index) => {
    const root = nodes.get(graph.roots[index])
    if (
      !root ||
      root.target.chainId !== target.chainId ||
      root.target.token.toLowerCase() !== target.tokenLowercase ||
      root.target.timestamp !== target.eodTimestamp
    )
      throw new Error('Gap report target identity mismatch')
    const identity = { chainId: target.chainId, token: target.token, timestamp: target.eodTimestamp }
    if (root.path) {
      try {
        const resolution = validateGraphResolution(root, target, nodes)
        return {
          ...identity,
          status: 'validated-candidate',
          price: resolution.price,
          source: resolution.source,
          adapter: root.path.adapter,
          blockNumber: root.path.blockNumber,
          observedTimestamp: root.path.observedTimestamp,
          blockers: []
        }
      } catch {
        return {
          ...identity,
          status: 'invalid-candidate',
          blockers: [
            {
              ...identity,
              reason: 'invalid',
              adapter: root.path.adapter,
              detail: 'Graph evidence failed historical validation'
            }
          ]
        }
      }
    }
    const blockers: Array<{
      chainId: number
      token: string
      timestamp: number
      reason: string
      adapter: string
      detail: string
    }> = []
    const seen = new Set<string>()
    const visit = (node: GraphNode) => {
      if (seen.has(node.key) || node.path) return
      seen.add(node.key)
      const id = { chainId: node.target.chainId, token: node.target.token, timestamp: node.target.timestamp! }
      for (const issue of [...node.attempts, ...node.routes.flatMap((route) => (route.error ? [route.error] : []))])
        blockers.push({
          ...id,
          reason: issue.reason,
          adapter: issue.adapter,
          detail:
            safePricingFailure(issue.error) ??
            (issue.reason === 'retryable'
              ? 'Provider/RPC request failed; history is not established missing'
              : `Pricing route failed (${issue.reason}); inspect private replay evidence`)
        })
      if (node.market === 'missing' && !node.routes.length && !node.attempts.length)
        blockers.push({
          ...id,
          reason: 'unsupported',
          adapter: 'market-and-adapters',
          detail: 'No matching historical market observation or supported on-chain conversion'
        })
      for (const route of node.routes)
        for (const dependency of route.dependencies) {
          if (dependency.cutoff)
            blockers.push({
              ...id,
              reason: dependency.cutoff,
              adapter: route.adapter,
              detail: 'Dependency exploration limit reached'
            })
          else {
            const child = nodes.get(dependency.key)
            if (child) visit(child)
            else throw new Error('Gap report dependency missing from graph')
          }
        }
    }
    visit(root)
    if (!blockers.length)
      blockers.push({
        ...identity,
        reason: root.reason ?? 'unsupported',
        adapter: 'graph',
        detail: `No usable dependency path (${root.reason ?? 'unsupported'})`
      })
    return { ...identity, status: 'unresolved', blockers }
  })
  return {
    version: 1,
    manifestDigest: manifest.digest,
    targets,
    summary: {
      targets: targets.length,
      candidates: targets.filter((t) => t.status === 'validated-candidate').length,
      unresolved: targets.filter((t) => t.status === 'unresolved').length,
      rejected: targets.filter((t) => t.status === 'invalid-candidate').length
    }
  }
}
