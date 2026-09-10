import { getBatchHistoricalPrices, type QueryExecutor } from '../../src/db/queries'
import type { RecursivePriceTarget, ResolvedPricePath } from '../../src/sources/onchain/types'
import { chainIdToName } from '../../src/utils/chains'
import { chunk } from '../../src/utils'
const key = (target: RecursivePriceTarget) =>
  target.chainId + ':' + target.token.toLowerCase() + ':' + target.timestamp

/** Existing rows are accepted database prices. Their EOD storage key is not
 * represented as a newly observed provider timestamp; that limitation is explicit. */
export function storedHistoricalPrices(pool: QueryExecutor) {
  const cache = new Map<string, ResolvedPricePath | null>()
  return {
    get: (target: RecursivePriceTarget) => cache.get(key(target)) ?? null,
    async prefetch(targets: RecursivePriceTarget[]) {
      const missing = [
        ...new Map(
          targets.filter((target) => !cache.has(key(target))).map((target) => [key(target), target])
        ).values()
      ]
      for (const group of chunk(missing, 1000)) {
        const rows = await getBatchHistoricalPrices(
          pool,
          group.map((target) => ({
            chain: chainIdToName(target.chainId)!,
            token: target.token,
            timestamp: target.timestamp!
          }))
        )
        for (const target of group) {
          const row = rows.find(
            (row) =>
              row.chain === chainIdToName(target.chainId) &&
              row.token.toLowerCase() === target.token.toLowerCase() &&
              row.timestamp === target.timestamp
          )
          cache.set(
            key(target),
            row && Number.isFinite(row.price) && row.price > 0
              ? {
                  chainId: target.chainId,
                  token: target.token,
                  requestedTimestamp: target.timestamp,
                  observedTimestamp: row.timestamp,
                  priceUsd: row.price,
                  source: row.source,
                  symbol: row.symbol,
                  confidence: row.confidence,
                  adapter: 'stored-historical',
                  blockNumber: null,
                  inputs: [],
                  metadata: {
                    provenance: 'existing-token_prices-row',
                    storedTimestamp: row.timestamp,
                    providerObservationTimestamp: null
                  }
                }
              : null
          )
        }
      }
    }
  }
}
