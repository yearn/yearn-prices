import type { ResolvedPricePath } from '../sources/onchain/types'
import type { NormalizedTarget } from './manifest'

/** One final outcome per target; detailed constituent evidence stays in the graph. */
export function targetOutcome(
  target: Omit<NormalizedTarget, 'token'> & { token: string },
  status: string,
  path: ResolvedPricePath | null = null,
  reason: string | null = null
) {
  const observedTimestamp =
    path?.metadata.provenance === 'existing-token_prices-row' ? null : (path?.observedTimestamp ?? null)
  return {
    type: 'target-outcome',
    target: {
      chainId: target.chainId,
      chain: target.chain,
      token: target.token,
      tokenLowercase: target.tokenLowercase,
      eodTimestamp: target.eodTimestamp
    },
    status,
    price: path?.priceUsd ?? null,
    source: path?.source ?? null,
    method: path?.adapter ?? null,
    observedTimestamp,
    signedOffsetSeconds: observedTimestamp == null ? null : observedTimestamp - target.eodTimestamp,
    observationScope: path ? 'selected-path-summary' : null,
    reason
  }
}
