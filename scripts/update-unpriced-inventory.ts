import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { dateOf } from '../src/backfill/coverage'
import { dependencyBlockers, needsOwnPricing } from '../src/backfill/investigation'
import type { GraphNode } from '../src/sources/onchain/graph'

interface Observation {
  date: string
  role: 'root' | 'dependency'
  status: 'unresolved' | 'candidate'
  pricingNeed?: 'direct' | 'dependency'
  blockedBy?: Array<{ chainId: number; token: string; timestamp: number }>
  reason: string | null
  firstSeenRun: string
  lastCheckedRun: string
  runs: string[]
}
interface Asset {
  chainId: number
  token: string
  symbol?: string
  observations: Observation[]
}
interface Inventory {
  version: 1
  runs: Record<string, { sha256: string }>
  assets: Asset[]
}
const { values } = parseArgs({
  options: {
    graph: { type: 'string' },
    inventory: { type: 'string' },
    run: { type: 'string' }
  }
})
if (!values.graph || !values.inventory || !values.run) throw new Error('Required: --graph --inventory --run')
const bytes = readFileSync(values.graph)
const graph = JSON.parse(bytes.toString()) as { roots: string[]; nodes: GraphNode[] }
const inventory: Inventory = existsSync(values.inventory)
  ? JSON.parse(readFileSync(values.inventory, 'utf8'))
  : { version: 1, runs: {}, assets: [] }
if (inventory.version !== 1 || !Array.isArray(graph.nodes)) throw new Error('Unsupported inventory or graph')
const digest = createHash('sha256').update(bytes).digest('hex')
if (inventory.runs[values.run] && inventory.runs[values.run].sha256 !== digest)
  throw new Error('Run identifier already belongs to different evidence')
inventory.runs[values.run] = { sha256: digest }
const assets = new Map(inventory.assets.map((asset) => [asset.chainId + ':' + asset.token.toLowerCase(), asset]))
const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
const roots = new Set(graph.roots)
for (const node of graph.nodes) {
  const token = node.target.token.toLowerCase()
  const key = node.target.chainId + ':' + token
  if (!node.path && !assets.has(key)) assets.set(key, { chainId: node.target.chainId, token, observations: [] })
}

for (const node of graph.nodes) {
  if (node.target.timestamp == null) continue
  const token = node.target.token.toLowerCase()
  const key = node.target.chainId + ':' + token
  let asset = assets.get(key)
  if (!asset && node.path) continue
  if (!asset) {
    asset = { chainId: node.target.chainId, token, observations: [] }
    assets.set(key, asset)
  }
  const date = dateOf(node.target.timestamp)
  const role = roots.has(node.key) ? ('root' as const) : ('dependency' as const)
  let observation = asset.observations.find((entry) => entry.date === date && entry.role === role)
  if (!observation) {
    observation = {
      date,
      role,
      status: 'unresolved',
      reason: null,
      firstSeenRun: values.run,
      lastCheckedRun: values.run,
      runs: []
    }
    asset.observations.push(observation)
  }
  // Multiple graph block contexts may exist for the same day. A failed context
  // must not erase a candidate found in another context of this same run.
  if (!(observation.lastCheckedRun === values.run && observation.status === 'candidate' && !node.path)) {
    const blockers = dependencyBlockers(node, nodes)
    const previousDirect = observation.lastCheckedRun === values.run && observation.pricingNeed === 'direct'
    observation.pricingNeed = !node.path && blockers && !previousDirect ? 'dependency' : 'direct'
    observation.blockedBy = !node.path && blockers ? blockers : []
    observation.status = node.path ? 'candidate' : 'unresolved'
    observation.reason = node.path ? null : node.reason
  }
  observation.lastCheckedRun = values.run
  observation.runs = [...new Set([...observation.runs, values.run])]
}
inventory.assets = [...assets.values()].sort((a, b) => a.chainId - b.chainId || a.token.localeCompare(b.token))
for (const asset of inventory.assets)
  asset.observations.sort((a, b) => a.date.localeCompare(b.date) || a.role.localeCompare(b.role))
const temporary = values.inventory + '.tmp'
writeFileSync(temporary, JSON.stringify(inventory, null, 2) + '\n')
renameSync(temporary, values.inventory)
const actionable = {
  ...inventory,
  assets: inventory.assets
    .filter((asset) => asset.observations.some(needsOwnPricing))
    .map((asset) => ({
      ...asset,
      observations: asset.observations.filter(needsOwnPricing)
    }))
}
writeFileSync(
  values.inventory.replace(/\.json$/, '') + '.investigation.json',
  JSON.stringify(actionable, null, 2) + '\n'
)
console.log(JSON.stringify({ assets: inventory.assets.length, runs: Object.keys(inventory.runs).length }))
