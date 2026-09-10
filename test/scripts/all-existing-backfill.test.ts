import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  query: vi.fn(),
  end: vi.fn(),
  replay: vi.fn(),
  provider: vi.fn(),
  finalize: vi.fn()
}))
vi.mock('node:util', () => ({ parseArgs: () => ({ values: mocks.values }) }))
vi.mock('../../src/db', () => ({ createPool: () => ({ query: mocks.query, end: mocks.end }) }))
vi.mock('../../scripts/backfill-historical-gaps', () => ({ preflightTokenCasings: vi.fn() }))
vi.mock('../../src/backfill/priced-keys', () => ({
  priceKey: () => 'stored',
  readPricedKeys: vi.fn(async () => new Set(['stored']))
}))
vi.mock('../../scripts/lib/graph-replay', () => ({ replayGraph: mocks.replay }))
vi.mock('../../scripts/lib/offline-provider', () => ({ offlineProvider: mocks.provider }))
vi.mock('../../src/backfill/finalize', () => ({ finalizeBackfillTargets: mocks.finalize }))
vi.mock('../../src/backfill/provenance', () => ({ gitRevision: () => 'test' }))

const directory = mkdtempSync(join(tmpdir(), 'all-existing-'))
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('reports all targets skipped without graph discovery, provider calls or writes', async () => {
  const manifest = join(directory, 'manifest.json')
  const run = join(directory, 'run.jsonl')
  const out = join(directory, 'projection')
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      targets: [{ chainId: 1, token: '0x0000000000000000000000000000000000000001', eodTimestamp: 1704067199 }]
    })
  )
  vi.stubEnv('TEST_DATABASE_URL', 'unused')
  mocks.values = { manifest, out: run, 'database-url-env': 'TEST_DATABASE_URL', write: true }
  await import('../../scripts/backfill-historical-graph')
  const records = readFileSync(run, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.find((record) => record.type === 'existing')).toMatchObject({ skipped: 1 })
  expect(records.find((record) => record.type === 'summary')).toMatchObject({
    inserted: 0,
    wouldInsert: 0,
    unresolved: 0,
    skippedConcurrentExisting: 0
  })
  expect(records.at(-1).type).toBe('complete')
  expect(mocks.replay).not.toHaveBeenCalled()
  expect(mocks.provider).not.toHaveBeenCalled()
  expect(mocks.finalize).not.toHaveBeenCalled()
  expect(mocks.query).not.toHaveBeenCalled()
  expect(mocks.end).toHaveBeenCalledOnce()
  mocks.values = { run, out }
  await import('../../scripts/report-post-backfill')
  expect(JSON.parse(readFileSync(out + '.json', 'utf8'))).toMatchObject({
    originalTargets: 1,
    alreadyStored: 1,
    expectedNewPrices: 0,
    remainingOriginalTargets: 0,
    investigationAssets: 0,
    missingAssetDays: 0,
    assets: []
  })
})
