import { describe, expect, it, vi } from 'vitest'
import { runDayAlignmentPhase } from '../../scripts/lib/day-alignment-runner'

function actions(overrides: Partial<Parameters<typeof runDayAlignmentPhase>[1]> = {}) {
  return {
    repairPrices: vi.fn(async () => true),
    rescaleDerived: vi.fn(async () => {}),
    verify: vi.fn(async () => true),
    cleanup: vi.fn(async () => {}),
    ...overrides
  }
}

describe('day alignment phase status', () => {
  it('returns failure after a partially failed prices phase', async () => {
    const run = actions({ repairPrices: vi.fn(async () => false) })

    await expect(runDayAlignmentPhase('prices', run)).resolves.toEqual({ exitCode: 1, pricesSucceeded: false })
  })

  it('stops all mode before derived repair after a failed prices phase', async () => {
    const run = actions({ repairPrices: vi.fn(async () => false) })

    await expect(runDayAlignmentPhase('all', run)).resolves.toEqual({ exitCode: 1, pricesSucceeded: false })
    expect(run.rescaleDerived).not.toHaveBeenCalled()
  })

  it('returns failure when verification finds a mismatch', async () => {
    const run = actions({ verify: vi.fn(async () => false) })

    await expect(runDayAlignmentPhase('verify', run)).resolves.toEqual({ exitCode: 1, pricesSucceeded: true })
  })

  it('runs derived repair after a successful prices phase in all mode', async () => {
    const run = actions()

    await expect(runDayAlignmentPhase('all', run)).resolves.toEqual({ exitCode: 0, pricesSucceeded: true })
    expect(run.rescaleDerived).toHaveBeenCalledOnce()
  })
})
