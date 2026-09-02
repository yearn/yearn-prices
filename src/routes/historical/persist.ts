import type { Pool } from '@neondatabase/serverless'
import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS } from '../../clients/defillama'
import { insertTokenPrices } from '../../db'
import type { HistoricalPrice } from '../../sources/types'
import type { ExactPriceRecord, HistoricalRequestTuple, PriceSource } from '../../types'
import { isClosedDay } from '../../utils'

export interface ResolvedPriceRecord extends ExactPriceRecord {
  /** Timestamp of the underlying observation, not of the day it is keyed under. */
  observedAt: number
}

export function toResolvedRecord(request: HistoricalRequestTuple, price: HistoricalPrice): ResolvedPriceRecord {
  return {
    chain: request.chain,
    token: request.token,
    timestamp: request.timestamp,
    price: price.price,
    symbol: price.symbol,
    confidence: price.confidence,
    source: price.source as PriceSource,
    observedAt: price.timestamp
  }
}

/**
 * DeFiLlama answers with the nearest observation it has, ignoring searchWidth
 * for some markets: a thin token's "price" can be days from the requested day.
 * The warmup writer bounds those to searchWidth, and a request-path row that
 * skipped the bound would freeze an out-of-window observation as that day's
 * permanent close. A derived on-chain path inherits the observation timestamp of
 * the market leaf it prices against, so it carries the same drift and is bounded
 * too — except for a chainlink leaf, which reports the requested time instead of
 * its heartbeat age (src/registries/market-price.ts). Chainlink resolved directly
 * is exempt here for the same reason: its observation is the feed's own updatedAt
 * at the resolved block, which a heartbeat feed leaves stale between updates by
 * design.
 */
function isWithinObservationWindow(record: ResolvedPriceRecord): boolean {
  if (record.source === 'chainlink') {
    return true
  }
  return Math.abs(record.observedAt - record.timestamp) <= DEFI_LLAMA_SEARCH_WIDTH_SECONDS
}

/**
 * Best-effort request-path persistence. Only closed past days are written:
 * a current- or future-day key was resolved at "now", and writing it under the
 * day-end key would freeze that intraday value as the day's permanent close
 * once the row turns immutable at midnight (the invariant src/routes/spot.ts
 * documents). Returns false only when the insert threw; the caller then marks
 * the response no-store so the next request retries the write.
 */
export async function persistResolvedPrices(pool: Pool, records: ResolvedPriceRecord[]): Promise<boolean> {
  const rows = records.filter((record) => isClosedDay(record.timestamp) && isWithinObservationWindow(record))
  if (rows.length === 0) {
    return true
  }
  try {
    await insertTokenPrices(pool, rows)
    return true
  } catch (error) {
    console.warn(
      JSON.stringify({
        message: 'persist-resolved-failed',
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error)
      })
    )
    return false
  }
}
