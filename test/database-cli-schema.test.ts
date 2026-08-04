import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('database CLI schema isolation', () => {
  test('passes DATABASE_SCHEMA through an actual daily script entry point', () => {
    const result = spawnSync('bun', ['run', 'scripts/daily-price-status.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:password@127.0.0.1:1/prices',
        DATABASE_SCHEMA: 'unsafe-schema-name',
      },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('DATABASE_SCHEMA must be a safe Postgres identifier')
  })

  test('preserves candidate identity and evidence during checksum backfills', async () => {
    const source = await readFile('scripts/backfill-token-address-checksums.ts', 'utf8')
    const insertColumns = source.match(/INSERT INTO token_prices \(([^)]+)\)/s)?.[1] ?? ''

    for (const column of [
      'candidate_id',
      'observed_at',
      'evidence_kind',
      'quality',
      'adapter',
      'block_number',
      'input_evidence',
      'validation_status',
      'failure_reason',
      'evidence_metadata',
      'updated_at',
    ]) {
      expect(insertColumns).toContain(column)
      expect(source).toContain(`tp.${column}`)
    }
    expect(source).toContain(
      'ON CONFLICT (chain, token, timestamp, source, candidate_id) DO NOTHING',
    )
  })
})
