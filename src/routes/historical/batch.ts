import type { Pool } from '@neondatabase/serverless'
import { cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { HistoricalPrice, HistoricalPriceTarget } from '../../sources/types'
import type { Env, HistoricalRequestTuple, PriceSource } from '../../types'
import { chainNameToId, isClosedDay, parseBatchCoins, parseOptionalSource, toFetchTimestamp } from '../../utils'
import {
  buildOriginalKeyMap,
  buildTokenKey,
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
const REQUEST_RESOLUTION_DEADLINE_MS = 5_000

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
  misses: HistoricalRequestTuple[],
  deadlineAt: number
): Promise<ResolvedPriceRecord[]> {
  const budgeted = [
    ...interleaveByToken(misses.filter((miss) => isClosedDay(miss.timestamp))),
    ...interleaveByToken(misses.filter((miss) => !isClosedDay(miss.timestamp)))
  ].slice(0, MAX_UPSTREAM_RESOLUTIONS)
  const resolved: ResolvedPriceRecord[] = []
  const targetToMiss = new Map<HistoricalPriceTarget, HistoricalRequestTuple>()
  for (const miss of budgeted) {
    const chainId = chainNameToId(miss.chain)
    if (chainId !== undefined) {
      targetToMiss.set({ chainId, token: miss.token, timestamp: toFetchTimestamp(miss.timestamp) }, miss)
    }
  }

  let acceptingSettlements = true
  let settledCount = 0
  const onSettled = (target: HistoricalPriceTarget, entry: PromiseSettledResult<HistoricalPrice>): void => {
    if (!acceptingSettlements) return
    const miss = targetToMiss.get(target)
    if (!miss) return
    settledCount += 1
    if (entry.status === 'fulfilled') {
      const historical = entry.value
      resolved.push({
        chain: miss.chain,
        token: miss.token,
        timestamp: miss.timestamp,
        price: historical.price,
        symbol: historical.symbol,
        confidence: historical.confidence,
        source: historical.source as PriceSource,
        observedAt: historical.timestamp
      })
      return
    }
    console.warn(
      JSON.stringify({
        message: 'resolve-miss-failed',
        chain: miss.chain,
        token: miss.token,
        timestamp: miss.timestamp,
        error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      })
    )
  }

  const targets = [...targetToMiss.keys()]
  const work = registry.resolveBatch(targets, onSettled)

  const remainingMs = Math.max(deadlineAt - Date.now(), 0)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    work.then(() => 'settled' as const),
    new Promise<'deadline'>((resolve) => {
      timeoutId = setTimeout(() => resolve('deadline'), remainingMs)
    })
  ])
  if (timeoutId !== undefined) clearTimeout(timeoutId)
  acceptingSettlements = false
  if (outcome === 'deadline') {
    console.warn(
      JSON.stringify({
        message: 'batch-resolution-deadline',
        deadline_ms: REQUEST_RESOLUTION_DEADLINE_MS,
        attempted: targets.length,
        resolved: resolved.length,
        pending: targets.length - settledCount
      })
    )
  }
  return resolved
}

export async function handleBatchHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  registry?: HistoricalSourceRegistry
): Promise<Response> {
  const resolutionDeadlineAt = Date.now() + REQUEST_RESOLUTION_DEADLINE_MS
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
      const resolved = await resolveMisses(
        registry ?? historicalSourceRegistry(env),
        [...missByKey.values()],
        resolutionDeadlineAt
      )
      if (resolved.length > 0) {
        allPersisted = (await persistResolvedPrices(pool, resolved)) === resolved.length
        rows.push(...resolved)
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
