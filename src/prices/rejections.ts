import observations from './rejected-observations-2026-10.json'

// Immutable incident manifest, also seeded by the quarantine migration. Removing
// a rejection requires a reviewed data correction, not an RPC becoming available.
export const REJECTED_OBSERVATIONS = observations
const rejected = new Set(observations.map(({ chain, token, timestamp }) => `${chain}:${token}:${timestamp}`))

export function isRejectedPrice(chain: string, token: string, timestamp: number, source: string): boolean {
  if (source !== 'defillama' && source !== 'defillama-alias') return false
  const day = Math.floor(timestamp / 86_400) * 86_400 + 86_399
  return rejected.has(`${chain.toLowerCase()}:${token.toLowerCase()}:${day}`)
}

/** Fixed SQL identifiers only; never interpolate request data here. */
export const ACCEPTED_PRICE_SQL = `NOT EXISTS (
  SELECT 1 FROM rejected_price_observations rejected
  WHERE rejected.chain = tp.chain AND rejected.token = lower(tp.token)
    AND rejected.timestamp = tp.timestamp AND rejected.source = tp.source
)`
