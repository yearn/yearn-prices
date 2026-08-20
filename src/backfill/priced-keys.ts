import type { Pool } from '@neondatabase/serverless'
import { getBatchHistoricalPrices } from '../db/queries'
import type { HistoricalRequestTuple } from '../types'
import { chunk } from './inventory'

export function priceKey(chain: string, token: string, timestamp: number): string {
  return `${chain}:${token}:${timestamp}`
}

export async function readPricedKeys(
  pool: Pool,
  targets: Array<{ chain: string; token: string; eodTimestamp: number }>,
  readChunkSize: number
): Promise<Set<string>> {
  const priced = new Set<string>()
  const requests: HistoricalRequestTuple[] = targets.map((target) => ({
    chain: target.chain,
    token: target.token,
    timestamp: target.eodTimestamp
  }))

  for (const requestChunk of chunk(requests, readChunkSize)) {
    const rows = await getBatchHistoricalPrices(pool, requestChunk)
    for (const row of rows) {
      priced.add(priceKey(row.chain, row.token, row.timestamp))
    }
  }

  return priced
}
