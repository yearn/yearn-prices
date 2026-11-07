import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { parseManifest } from '../src/backfill/manifest'
import { graphGapReport } from './lib/graph-gap-report'

// Purely local: full replay graphs stay private; the report contains only
// target identities, validated candidates, and allowlisted failure details.
const { values } = parseArgs({
  options: { manifest: { type: 'string' }, graph: { type: 'string' }, out: { type: 'string' } }
})
if (!values.manifest || !values.graph || !values.out)
  throw new Error('Required: --manifest <file> --graph <file> --out <new file>')
const report = graphGapReport(
  JSON.parse(readFileSync(values.graph, 'utf8')),
  parseManifest(readFileSync(values.manifest))
)
writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report.summary))
