import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { Env, HistoricalRequestTuple, PriceSource } from '../../types'
import {
  chainNameToId,
  isClosedDay,
  isTodayNormalized,
  parseBatchCoins,
  parseOptionalSource,
  toFetchTimestamp
} from '../../utils'
import {
  buildOriginalKeyMap,
  buildTokenKey,
  carryOpenDayFromLastClose,
  groupRowsByToken,
  persistResolvedPrices,
  type ResolvedPriceRecord,
  toExactKey
} from './shared'

// Bounds the per-request upstream work (DeFiLlama + on-chain reads) so a batch
// full of gaps cannot push the Worker past its time budget. Leftover misses
// stay absent, exactly as before — and land on later requests once the
// resolved rows persist. The budget is spread round-robin across tokens so a
// leading token whose misses never resolve cannot starve the rest forever.
const MAX_UPSTREAM_RESOLUTIONS = 10

function interleaveByToken(misses: HistoricalRequestTuple[]): HistoricalRequestTuple[] {
  const byToken = new Map<string, HistoricalRequestTuple[]>()
  for (const miss of misses) {
    const key = buildTokenKey(miss.chain, miss.token)
    const bucket = byToken.get(key)
    if (bucket) {
      bucket.push(miss)
    } else {
      byToken.set(key, [miss])
    }
  }

  const interleaved: HistoricalRequestTuple[] = []
  for (let index = 0; interleaved.length < misses.length; index += 1) {
    for (const bucket of byToken.values()) {
      const miss = bucket[index]
      if (miss) {
        interleaved.push(miss)
      }
    }
  }
  return interleaved
}

async function resolveMisses(
  registry: HistoricalSourceRegistry,
  misses: HistoricalRequestTuple[]
): Promise<ResolvedPriceRecord[]> {
  const budgeted = [
    ...interleaveByToken(misses.filter((miss) => isClosedDay(miss.timestamp))),
    ...interleaveByToken(misses.filter((miss) => !isClosedDay(miss.timestamp)))
  ].slice(0, MAX_UPSTREAM_RESOLUTIONS)
  const settled = await Promise.allSettled(
    budgeted.map(async (miss): Promise<ResolvedPriceRecord | null> => {
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
        source: historical.source as PriceSource,
        observedAt: historical.timestamp
      }
    })
  )
  // A failed resolution stays a plain absence: callers already handle missing
  // entries, and one bad token must not fail the other 49. But an absence with
  // no log is invisible to alerting, so each rejection is logged before it is
  // dropped — budgeted and settled are index-aligned.
  const resolved: ResolvedPriceRecord[] = []
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') {
      if (entry.value !== null) {
        resolved.push(entry.value)
      }
      return
    }
    const miss = budgeted[index]
    console.warn(
      JSON.stringify({
        message: 'resolve-miss-failed',
        chain: miss.chain,
        token: miss.token,
        timestamp: miss.timestamp,
        error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      })
    )
  })
  return resolved
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
  let allPersisted = true

  if (!source) {
    const resolvedKeys = new Set(rows.map(toExactKey))
    // Deduped by exact key: distinct coins entries can normalize to the same
    // chain/token/day (address casing, chain-name casing), and each duplicate
    // would burn a resolution slot and double its price point in the response.
    const missByKey = new Map<string, HistoricalRequestTuple>()
    for (const entry of requests) {
      const key = toExactKey(entry)
      if (!resolvedKeys.has(key) && !missByKey.has(key)) {
        missByKey.set(key, entry)
      }
    }
    if (missByKey.size > 0) {
      const misses = [...missByKey.values()]
      const openDayMisses = misses.filter((miss) => isTodayNormalized(miss.timestamp))
      const upstreamMisses = misses.filter((miss) => !isTodayNormalized(miss.timestamp))
      const carried = await carryOpenDayFromLastClose(pool, openDayMisses, source)
      rows.push(...carried)
      if (upstreamMisses.length > 0) {
        const resolved = await resolveMisses(registry ?? historicalSourceRegistry(env), upstreamMisses)
        if (resolved.length > 0) {
          allPersisted = (await persistResolvedPrices(pool, resolved)) === resolved.length
          rows.push(...resolved)
        }
      }
    }
  }

  const coins = groupRowsByToken(rows, originalKeyMap)

  const requestedKeyCount = new Set(requests.map(toExactKey)).size
  const allResolved = rows.length === requestedKeyCount && allPersisted
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
