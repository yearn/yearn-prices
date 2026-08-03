import { spawnSync } from 'node:child_process'
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
})
