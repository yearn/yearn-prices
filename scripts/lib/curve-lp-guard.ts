import type { FinalizationResolution, FinalizationTarget } from '../../src/backfill/finalize'
import type { QueryExecutor } from '../../src/db/queries'
import { storedCurveLpGuard } from '../../src/prices/curve-lp-guard'
import { isRejectedPrice } from '../../src/prices/rejections'

export function storedTargetGuard(
  pool: QueryExecutor
): (target: FinalizationTarget & { resolution: FinalizationResolution }) => Promise<boolean> {
  const guard = storedCurveLpGuard(pool)
  return async (t) =>
    !isRejectedPrice(t.chain, t.token, t.eodTimestamp, t.resolution.source) &&
    guard(t.chainId, t.token, t.eodTimestamp, t.resolution.price)
}
