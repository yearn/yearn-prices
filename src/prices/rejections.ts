import { sql } from 'drizzle-orm'
import october from './rejected-observations-2026-10.json'
import november from './rejected-observations-2026-11.json'

const observations = [...october, ...november]

// Immutable incident manifest, also seeded by the quarantine migration. Removing
// a rejection requires a reviewed data correction, not an RPC becoming available.
export const REJECTED_OBSERVATIONS = observations
export const CURVE_LP_REJECTED_OBSERVATIONS = october
const rejected = new Set(observations.map(({ chain, token, timestamp }) => `${chain}:${token}:${timestamp}`))

export function isRejectedPrice(chain: string, token: string, timestamp: number, source: string): boolean {
  if (source !== 'defillama' && source !== 'defillama-alias') return false
  const day = Math.floor(timestamp / 86_400) * 86_400 + 86_399
  return rejected.has(`${chain.toLowerCase()}:${token.toLowerCase()}:${day}`)
}

/** Fixed SQL identifiers only; never interpolate request data here. */
export const NOT_REJECTED_PRICE_SQL = sql`NOT EXISTS (
  SELECT 1 FROM rejected_price_observations rejected
  WHERE rejected.chain = tp.chain AND rejected.token = lower(tp.token)
    AND rejected.timestamp = tp.timestamp AND rejected.source = tp.source
)`

export const SERVED_PRICE_SQL = sql`${NOT_REJECTED_PRICE_SQL} AND (
  tp.finalized = TRUE
  OR tp.timestamp >= to_timestamp(floor(extract(epoch from now()) / 86400)::bigint * 86400 - 1)
)`

export const ACCEPTED_PRICE_SQL = sql`${NOT_REJECTED_PRICE_SQL} AND (
  tp.finalized = TRUE
  OR tp.timestamp = to_timestamp(floor(extract(epoch from now()) / 86400)::bigint * 86400 + 86399)
)`
