import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
vi.mock('node:util', () => ({ parseArgs: () => ({ values: mocks.values }) }))
vi.mock('../../src/db', () => ({ createPool: () => ({ end: vi.fn() }) }))
vi.mock('../../scripts/backfill-historical-gaps', () => ({ preflightTokenCasings: vi.fn() }))
vi.mock('../../src/backfill/provenance', () => ({ gitRevision: () => 'test' }))
vi.mock('../../src/backfill/priced-keys', () => ({
  priceKey: (_chain: string, token: string) => token,
  readPricedKeys: async () => new Set(['0x0000000000000000000000000000000000000001'])
}))
vi.mock('../../scripts/lib/offline-provider', () => ({ offlineProvider: vi.fn() }))
vi.mock('../../scripts/lib/graph-replay', () => ({
  replayGraph: async ({
    targets,
    out
  }: {
    targets: Array<{ chainId: number; token: string; timestamp: number }>
    out: string
  }) => {
    const nodes = targets.map((target, i) => ({
      key: target.token,
      target,
      market: 'price',
      routes: [],
      reason: i === 1 ? 'unsupported' : null,
      path:
        i === 1
          ? null
          : {
              chainId: target.chainId,
              token: target.token,
              requestedTimestamp: target.timestamp,
              observedTimestamp: target.timestamp - 300,
              priceUsd: i === 2 ? -1 : 2,
              source: 'defillama',
              adapter: 'defillama',
              symbol: null,
              confidence: null,
              inputs: [],
              metadata: {}
            }
    }))
    writeFileSync(out + '.graph.json', JSON.stringify({ roots: nodes.map((node) => node.key), nodes }))
  }
}))
vi.mock('../../src/backfill/finalize', () => ({
  finalizeBackfillTargets: async (
    _pool: unknown,
    batch: Array<Record<string, unknown>>,
    options: {
      onBatchSettled: (batch: { results: Array<Record<string, unknown>> }) => void
    }
  ) => {
    options.onBatchSettled({ results: batch.map((target) => ({ ...target, status: 'inserted' })) })
    return { inserted: batch.length, skippedConcurrentExisting: 0, unresolved: 0 }
  }
}))

it('emits exactly one final outcome per normalized target with standalone insertion evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'backfill-outcomes-'))
  try {
    const manifest = join(directory, 'manifest.json')
    const out = join(directory, 'run.jsonl')
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        targets: [1, 2, 3, 4].map((id) => ({
          chainId: 1,
          token: '0x' + id.toString().padStart(40, '0'),
          eodTimestamp: 1704067199
        }))
      })
    )
    vi.stubEnv('TEST_DATABASE_URL', 'unused')
    mocks.values = { manifest, out, write: true, 'database-url-env': 'TEST_DATABASE_URL' }
    await import('../../scripts/backfill-historical-graph')
    const records = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.at(-1).type).toBe('complete')
    const outcomes = records.filter((record) => record.type === 'target-outcome')
    expect(outcomes).toHaveLength(4)
    expect(new Set(outcomes.map((record) => record.target.token)).size).toBe(4)
    expect(outcomes.map((record) => record.status).sort()).toEqual([
      'inserted',
      'rejected',
      'skipped_existing',
      'unresolved'
    ])
    expect(outcomes.find((record) => record.status === 'inserted')).toMatchObject({
      method: 'defillama',
      source: 'defillama',
      price: 2,
      observedTimestamp: 1704066899,
      signedOffsetSeconds: -300
    })
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
})
