import { describe, expect, test } from 'vitest'
import { validateLocalDatabaseWsProxy } from '../scripts/configure-local-database'

describe('local database configuration', () => {
  test('accepts loopback and rejects non-loopback proxy endpoints', () => {
    expect(validateLocalDatabaseWsProxy('127.0.0.1:55433/v1')).toBe('127.0.0.1:55433/v1')
    expect(() => validateLocalDatabaseWsProxy('database.example:443/v1'))
      .toThrow('must use a loopback host')
  })
})
