export interface DayAlignmentPhaseActions {
  repairPrices: () => Promise<boolean>
  rescaleDerived: () => Promise<void>
  verify: () => Promise<boolean>
  cleanup: () => Promise<void>
}

export interface DayAlignmentPhaseResult {
  exitCode: 0 | 1
  pricesSucceeded: boolean
}

/** Run selected phases and retain failed outcomes as a nonzero CLI result. */
export async function runDayAlignmentPhase(
  phase: string,
  actions: DayAlignmentPhaseActions
): Promise<DayAlignmentPhaseResult> {
  let exitCode: 0 | 1 = 0
  let pricesSucceeded = true

  if (phase === 'prices' || phase === 'all') {
    pricesSucceeded = await actions.repairPrices()
    if (!pricesSucceeded) exitCode = 1
  }
  if (phase === 'derived' || (phase === 'all' && pricesSucceeded)) {
    await actions.rescaleDerived()
  }
  if (phase === 'verify' && !(await actions.verify())) {
    exitCode = 1
  }
  if (phase === 'cleanup') {
    await actions.cleanup()
  }

  return { exitCode, pricesSucceeded }
}
