import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices, insertTokenPrices } from '../../db'
import { jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { Env, ExactPriceRecord, HistoricalRequestTuple, PriceSource } from '../../types'
import { chainNameToId, parseBatchCoins, parseOptionalSource, toFetchTimestamp } from '../../utils'
import { buildOriginalKeyMap, groupRowsByToken, toExactKey } from './shared'

// Bounds the per-request upstream work (DeFiLlama + on-chain reads) so a batch
// full of gaps cannot push the Worker past its time budget. Leftover misses
// stay absent, exactly as before — and land on later requests once the
// resolved rows persist.
const MAX_UPSTREAM_RESOLUTIONS = 10

async function resolveMisses(
  registry: HistoricalSourceRegistry,
  misses: HistoricalRequestTuple[]
): Promise<ExactPriceRecord[]> {
  const settled = await Promise.allSettled(
    misses.slice(0, MAX_UPSTREAM_RESOLUTIONS).map(async (miss): Promise<ExactPriceRecord | null> => {
      const chainId = chainNameToId(miss.chain)
      if (chainId === undefined) return null
      const historical = await registry.resolve(chainId, miss.token, toFetchTimestamp(miss.timestamp))
      return {
        chain: miss.chain,
        token: miss.token,
        timestamp: miss.timestamp,
        price: historical.price,
        symbol: historical.symbol,
        confidence: historical.confidence,
        source: historical.source as PriceSource
      }
    })
  )
  // A failed resolution stays a plain absence: callers already handle missing
  // entries, and one bad token must not fail the other 49.
  return settled
    .filter((entry): entry is PromiseFulfilledResult<ExactPriceRecord | null> => entry.status === 'fulfilled')
    .map((entry) => entry.value)
    .filter((record): record is ExactPriceRecord => record !== null)
}

export async function handleBatchHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  registry?: HistoricalSourceRegistry
): Promise<Response> {
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins')
  const requests = parseBatchCoins(rawCoins)
  const originalKeyMap = buildOriginalKeyMap(rawCoins!)
  const rows = await getBatchHistoricalPrices(pool, requests, source)

  if (!source) {
    const resolvedKeys = new Set(rows.map(toExactKey))
    const misses = requests.filter((entry) => !resolvedKeys.has(toExactKey(entry)))
    if (misses.length > 0) {
      const resolved = await resolveMisses(registry ?? historicalSourceRegistry(env), misses)
      if (resolved.length > 0) {
        await insertTokenPrices(pool, resolved)
        rows.push(...resolved)
      }
    }
  }

  const coins = groupRowsByToken(rows, originalKeyMap)

  const requestedKeyCount = new Set(requests.map(toExactKey)).size
  const allResolved = rows.length === requestedKeyCount
  return jsonResponse(
    { coins: Object.fromEntries(coins.entries()) },
    {
      headers: {
        'cache-control': cacheControlForBatch(
          requests.map((entry) => entry.timestamp),
          allResolved
        )
      }
    }
  )
}
