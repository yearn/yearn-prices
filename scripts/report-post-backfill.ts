import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { dateOf, ranges } from '../src/backfill/coverage'
import { remainingGapPositions, remainingPriceProjection } from '../src/backfill/projection'
import { type GraphNode, graphKey } from '../src/sources/onchain/graph'

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    graph: { type: 'string' },
    inventory: { type: 'string' },
    coverage: { type: 'string' },
    out: { type: 'string' }
  }
})
if (!values.run || !values.out)
  throw new Error('Required: --run --out <prefix>; unresolved runs also require --graph --inventory --coverage')
const records = readFileSync(values.run, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
if (records.at(-1)?.type !== 'complete') throw new Error('Projection requires a completed backfill report')
const hasMissing = records.some((record) => ['unresolved', 'rejected'].includes(record.type))
if (hasMissing && (!values.graph || !values.inventory || !values.coverage))
  throw new Error('Unresolved runs require --graph --inventory --coverage')
const graph = (values.graph ? JSON.parse(readFileSync(values.graph, 'utf8')) : { roots: [], nodes: [] }) as {
  roots: string[]
  nodes: GraphNode[]
}
const inventory = (values.inventory ? JSON.parse(readFileSync(values.inventory, 'utf8')) : { assets: [] }) as {
  assets: Array<{ chainId: number; token: string; symbol?: string }>
}
const coverage = (values.coverage ? JSON.parse(readFileSync(values.coverage, 'utf8')) : { assets: [] }) as {
  assets: Array<{
    chainId: number
    token: string
    requestedGaps: { first: number | null; last: number | null; incomplete: boolean }
    storedAnyTime: { rows: number }
    usableRanges: Array<{ start: string; end: string }>
  }>
}
const missing = records
  .filter((record) => ['unresolved', 'rejected'].includes(record.type))
  .map(
    (record) =>
      record.graphKey ??
      graphKey({
        chainId: record.target.chainId,
        token: record.target.token,
        timestamp: record.target.eodTimestamp
      })
  )
const projection = remainingPriceProjection(graph.nodes, missing)
const summary = records.find((record) => record.type === 'summary')
const existing = records.find((record) => record.type === 'existing')?.skipped ?? 0
if (!summary || summary.unresolved !== missing.length)
  throw new Error('Backfill accounting does not match remaining roots')
const assets = projection.assets.map((asset) => {
  const identity = inventory.assets.find(
    (item) => item.chainId === asset.chainId && item.token.toLowerCase() === asset.token
  )
  const history = coverage.assets.find(
    (item) => item.chainId === asset.chainId && item.token.toLowerCase() === asset.token
  )
  const observationsOutsideBackfill = asset.dates.filter(({ timestamp }) =>
    history?.usableRanges.some((range) => range.start <= dateOf(timestamp) && dateOf(timestamp) <= range.end)
  )
  return {
    ...asset,
    symbol: identity?.symbol ?? asset.token,
    dateRanges: ranges(asset.dates.map((item) => item.timestamp)),
    firstKnownPriceDate: history?.requestedGaps.first == null ? null : dateOf(history.requestedGaps.first),
    lastKnownPriceDate: history?.requestedGaps.last == null ? null : dateOf(history.requestedGaps.last),
    gapPositions: Object.fromEntries(
      Object.entries(
        remainingGapPositions(
          asset.dates.map((item) => item.timestamp),
          history?.requestedGaps.first ?? null,
          history?.requestedGaps.last ?? null
        )
      ).map(([position, dates]) => [position, ranges(dates)])
    ),
    historicalPricesFound: history ? history.requestedGaps.first != null || history.storedAnyTime.rows > 0 : null,
    historicalResearchIncomplete: history?.requestedGaps.incomplete ?? true,
    observationsOutsideBackfill: observationsOutsideBackfill.map((item) => dateOf(item.timestamp))
  }
})
const report = {
  assumption: 'Production backfill has the same outcome as this completed local dry run; verify after execution.',
  originalTargets: records[0].targets,
  alreadyStored: existing,
  expectedNewPrices: records[0].mode === 'write' ? summary.inserted : summary.wouldInsert,
  remainingOriginalTargets: projection.remainingRootCount,
  dependencyOnlyAssets: projection.dependencyOnlyAssetCount,
  investigationAssets: assets.length,
  missingAssetDays: assets.reduce((n, a) => n + a.dates.length, 0),
  assets
}
writeFileSync(values.out + '.json', JSON.stringify(report, null, 2) + '\n')
const md = [
  '# Expected gaps after backfill',
  '',
  report.assumption,
  '',
  'Expected outcome: ' +
    report.expectedNewPrices +
    ' new original-target prices; ' +
    report.remainingOriginalTargets +
    ' original targets remain unresolved (' +
    report.alreadyStored +
    ' were already stored).',
  '',
  'The list below contains only the ' +
    report.investigationAssets +
    ' assets needed to address the remaining failures. Pools and wrappers blocked only by these assets are excluded. Each listed date remains unresolved by the local backfill. Dates resolved by that run and unused graph branches are omitted.',
  '',
  'Historical research is context only. A price found by the separate wider scan does not count as a backfill success unless the local backfill actually resolved it. Those observations are retained as follow-up leads.',
  '',
  'Gap positions apply only to the remaining dates: before the first known price, after the last known price, or interior (within the known date range, including its endpoints). Multiple labels describe different missing dates. No-known-history means no usable historical range was found; incomplete research makes these positions provisional.',
  '',
  '| Asset | Chain | Address | Remaining dates | Gap position | Historical prices |',
  '|---|---:|---|---:|---|---|'
]
for (const asset of assets)
  md.push(
    '| ' +
      String(asset.symbol).replaceAll('|', '\\|') +
      ' | ' +
      asset.chainId +
      ' | ' +
      asset.token +
      ' | ' +
      asset.dates.length +
      ' | ' +
      Object.keys(asset.gapPositions).join(', ') +
      ' | ' +
      (asset.historicalPricesFound
        ? 'Found in investigated history'
        : asset.historicalPricesFound === false
          ? 'None found in investigated history'
          : 'Not examined') +
      (asset.historicalResearchIncomplete ? ' (research incomplete)' : '') +
      ' |'
  )
md.push(
  '',
  'The JSON report contains exact remaining dates and affected request identifiers. No production writes are implied by this projection.'
)
writeFileSync(values.out + '.md', md.join('\n') + '\n')
console.log(
  JSON.stringify({
    assets: report.investigationAssets,
    missingAssetDays: report.missingAssetDays,
    expectedNewPrices: report.expectedNewPrices,
    remainingOriginalTargets: report.remainingOriginalTargets
  })
)
