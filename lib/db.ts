import { neonConfig, Pool } from '@neondatabase/serverless'

// Route single (non-transactional) pool.query() calls over HTTP fetch instead of a
// WebSocket. Every request opens and ends its own pool for one-shot reads, so the
// WebSocket handshake + teardown would be pure per-request latency on Workers.
neonConfig.poolQueryViaFetch = true

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString })
}
