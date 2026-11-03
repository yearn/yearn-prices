import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
vi.mock('node:util', () => ({ parseArgs: () => ({ values: mocks.values }) }))

let directory = ''
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'post-backfill-report-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function writeReport(outcomes: Array<{ token: string; status: string }>) {
  const run = join(directory, 'run.jsonl')
  const out = join(directory, 'projection')
  const remaining = outcomes.filter((outcome) =>
    ['unresolved', 'rejected', 'rejected_implausible'].includes(outcome.status)
  )
  const lines: unknown[] = [
    { type: 'run', targets: outcomes.length, mode: 'write' },
    { type: 'existing', skipped: outcomes.filter((outcome) => outcome.status === 'skipped_existing').length }
  ]
  for (const outcome of outcomes) {
    lines.push({
      type: 'target-outcome',
      target: { chainId: 1, token: outcome.token, eodTimestamp: 1704067199 },
      status: outcome.status
    })
  }
  lines.push({
    type: 'summary',
    inserted: outcomes.filter((outcome) => outcome.status === 'inserted').length,
    wouldInsert: 0,
    skippedConcurrentExisting: outcomes.filter((outcome) => outcome.status === 'skipped_concurrent_existing').length,
    unresolved: outcomes.filter((outcome) => ['unresolved', 'rejected'].includes(outcome.status)).length,
    rejectedImplausible: outcomes.filter((outcome) => outcome.status === 'rejected_implausible').length
  })
  lines.push({ type: 'complete' })
  writeFileSync(run, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  if (remaining.length) {
    const graphKey = (token: string) => `1:${token.toLowerCase()}:1704067199:none`
    writeFileSync(
      join(directory, 'graph.json'),
      JSON.stringify({
        roots: remaining.map(({ token }) => graphKey(token)),
        nodes: remaining.map(({ token }) => ({
          key: graphKey(token),
          target: { chainId: 1, token, timestamp: 1704067199 },
          path: { source: 'defillama', priceUsd: 1 },
          reason: null,
          routes: []
        }))
      })
    )
    writeFileSync(join(directory, 'inventory.json'), JSON.stringify({ assets: [] }))
    writeFileSync(join(directory, 'coverage.json'), JSON.stringify({ assets: [] }))
  }

  mocks.values = {
    run,
    out,
    ...(remaining.length
      ? {
          graph: join(directory, 'graph.json'),
          inventory: join(directory, 'inventory.json'),
          coverage: join(directory, 'coverage.json')
        }
      : {})
  }
  await import('../../scripts/report-post-backfill')
  return JSON.parse(readFileSync(out + '.json', 'utf8'))
}

it('reports a run containing only a finalization plausibility rejection as unresolved', async () => {
  const report = await writeReport([{ token: '0xrejected', status: 'rejected_implausible' }])

  expect(report).toMatchObject({
    originalTargets: 1,
    expectedNewPrices: 0,
    remainingOriginalTargets: 1,
    investigationAssets: 1,
    missingAssetDays: 1
  })
  expect(report.assets[0]).toMatchObject({ token: '0xrejected', dates: [{ timestamp: 1704067199 }] })
})

it('reconciles stored, inserted, concurrent and rejected target outcomes together', async () => {
  const report = await writeReport([
    { token: '0xstored', status: 'skipped_existing' },
    { token: '0xinserted', status: 'inserted' },
    { token: '0xconcurrent', status: 'skipped_concurrent_existing' },
    { token: '0xrejected', status: 'rejected_implausible' }
  ])

  expect(report).toMatchObject({
    originalTargets: 4,
    alreadyStored: 1,
    expectedNewPrices: 1,
    concurrentExisting: 1,
    remainingOriginalTargets: 1
  })
})
