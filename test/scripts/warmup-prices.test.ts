import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isWarmupDegraded, MAX_FAILURE_RATE } from '../../scripts/warmup-status'

const warmupSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/warmup-prices.ts'), 'utf8')

const base = {
  attempts: 10,
  failures: 0,
  insertedDirect: 5,
  insertedCurve: 0,
  insertedDerived: 0
}

describe('isWarmupDegraded', () => {
  it('is not degraded at the failure-rate cap', () => {
    const failures = Math.floor(base.attempts * MAX_FAILURE_RATE)
    expect(isWarmupDegraded({ ...base, failures })).toBe(false)
  })

  it('is degraded above the failure-rate cap', () => {
    const failures = Math.floor(base.attempts * MAX_FAILURE_RATE) + 1
    expect(isWarmupDegraded({ ...base, failures })).toBe(true)
  })

  it('is degraded when attempts ran but nothing was written', () => {
    expect(isWarmupDegraded({ ...base, insertedDirect: 0 })).toBe(true)
  })

  it('counts curve and derived inserts as writes', () => {
    expect(isWarmupDegraded({ ...base, insertedDirect: 0, insertedCurve: 1 })).toBe(false)
    expect(isWarmupDegraded({ ...base, insertedDirect: 0, insertedDerived: 1 })).toBe(false)
  })

  it('is not degraded when there was no work', () => {
    expect(isWarmupDegraded({ ...base, attempts: 0, insertedDirect: 0 })).toBe(false)
  })
})

describe('scripts/warmup-prices.ts', () => {
  it('fails the process when the shipped degraded predicate says so', () => {
    expect(warmupSrc).toContain('isWarmupDegraded(stats)')
    expect(warmupSrc).toContain('process.exitCode = 1')
  })
})
