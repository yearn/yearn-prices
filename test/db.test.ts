import { describe, expect, test } from 'vitest'
import { createPool } from '../src/db'

describe('database schema isolation', () => {
  test('accepts a safe isolated schema without exposing a second database URL', async () => {
    const pool = createPool('postgres://user:pass@example.test/database', 'yearn_prices_validation_20260802')
    const connectionString = (pool as unknown as { options: { connectionString: string } }).options.connectionString
    const url = new URL(connectionString)

    expect(url.searchParams.get('options')).toBe('-c search_path=yearn_prices_validation_20260802')
    await pool.end()
  })

  test('rejects unsafe schema identifiers', () => {
    expect(() => createPool('postgres://user:pass@example.test/database', 'public; DROP SCHEMA public'))
      .toThrow('safe Postgres identifier')
  })
})
