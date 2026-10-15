import { insertTokenPrices, type Queryable, type QueryExecutor } from '../../src/db/queries'
import { ACCEPTED_PRICE_SQL } from '../../src/prices/rejections'
import type { ResolvedPricePath } from '../../src/sources/onchain/types'
import { SOURCE_PRIORITY } from '../../src/types'
import { normalizeTokenAddress, unixToIsoTimestamp } from '../../src/utils'

export interface RepairTarget {
  chain: string
  chainId: number
  token: string
  timestamp: number
  rederive: boolean
}

export async function repairCurveLpOutlier(
  pool: QueryExecutor & Queryable,
  target: RepairTarget,
  write: boolean,
  derive: () => Promise<ResolvedPricePath | null>
) {
  const params = [target.chain, target.token.toLowerCase(), unixToIsoTimestamp(target.timestamp)]
  // Commit containment before RPC work. A failed or interrupted derivation must
  // never leave a confirmed bad row selectable. The manifest survives deletion,
  // so subsequent runs retry replacement even when no provider row remains.
  const quarantined = write
    ? await pool.query(
        `
        WITH removed AS (
          DELETE FROM token_prices tp USING rejected_price_observations rejected
          WHERE tp.chain = $1 AND lower(tp.token) = $2 AND tp.timestamp = $3::timestamptz
            AND rejected.chain = tp.chain AND rejected.token = lower(tp.token)
            AND rejected.timestamp = tp.timestamp AND rejected.source = tp.source
          RETURNING tp.*, rejected.reason AS rejection_reason
        )
        INSERT INTO quarantined_token_prices (original_row, reason)
        SELECT to_jsonb(removed) - 'rejection_reason', rejection_reason FROM removed
        RETURNING id`,
        params
      )
    : { rows: [] }

  const { rows: existing } = await pool.query<{ source: string; price: string | number }>(
    `SELECT source, price FROM token_prices tp
     WHERE chain = $1 AND lower(token) = $2 AND timestamp = $3::timestamptz
       AND source NOT IN ('defillama', 'defillama-alias') AND ${ACCEPTED_PRICE_SQL}
       AND price > 0 AND price < 'Infinity'::numeric
     ORDER BY array_position($4::text[], source) LIMIT 1`,
    [...params, [...SOURCE_PRIORITY]]
  )
  if (existing.length)
    return { status: 'existing' as const, quarantined: quarantined.rows.length, existing: existing[0] }
  if (!target.rederive) return { status: 'quarantined' as const, quarantined: quarantined.rows.length }

  let path: ResolvedPricePath | null
  try {
    path = await derive()
    if (!path) return { status: 'unresolved' as const, quarantined: quarantined.rows.length, reason: 'not-derivable' }
    if (
      path.adapter !== 'curve-reserve-nav' ||
      path.chainId !== target.chainId ||
      path.token.toLowerCase() !== target.token.toLowerCase() ||
      path.requestedTimestamp !== target.timestamp ||
      !Number.isFinite(path.priceUsd) ||
      path.priceUsd <= 0
    ) {
      throw new Error('Replacement is not a valid dated Curve reserve price for this target')
    }
  } catch (error) {
    return {
      status: 'unresolved' as const,
      quarantined: quarantined.rows.length,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
  if (write) {
    await insertTokenPrices(pool, [
      {
        chain: target.chain,
        token: normalizeTokenAddress(target.token),
        timestamp: target.timestamp,
        price: path.priceUsd,
        symbol: path.symbol,
        confidence: path.confidence,
        source: 'derived'
      }
    ])
  }
  return {
    status: write ? ('derived' as const) : ('would-derive' as const),
    quarantined: quarantined.rows.length,
    path
  }
}
