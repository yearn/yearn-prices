import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE, cacheControlForBatch } from '../../cache'
import { getBatchHistoricalPrices } from '../../db'
import { jsonResponse } from '../../http'
import { type HistoricalSourceRegistry, historicalSourceRegistry } from '../../registries'
import type { HistoricalPrice, HistoricalPriceTarget } from '../../sources/types'
import type { Env, HistoricalRequestTuple } from '../../types'
import { chainNameToId, isClosedDay, parseBatchCoins, parseOptionalSource, toFetchTimestamp } from '../../utils'
import { persistResolvedPrices, type ResolvedPriceRecord, toResolvedRecord } from './persist'
import { buildOriginalKeyMap, buildTokenKey, groupRowsByToken, isNotFound, toExactKey } from './shared'

// Bounds the per-request upstream work (DeFiLlama + on-chain reads) so a batch
// full of gaps cannot push the Worker past its time budget. Leftover misses
// stay absent and land on later requests once the resolved rows persist. The
// budget is spread round-robin across tokens, closed days first, so a leading
// token whose misses never resolve cannot starve the rest forever.
const MAX_UPSTREAM_RESOLUTIONS = 10
const REQUEST_RESOLUTION_DEADLINE_MS = 5_000

interface Resolution {
  resolved: ResolvedPriceRecord[]
  failed: boolean
}

function interleaveByToken(misses: HistoricalRequestTuple[]): HistoricalRequestTuple[] {
  const byToken = new Map<string, HistoricalRequestTuple[]>()
  for (const miss of misses) {
    const key = buildTokenKey(miss.chain, miss.token)
    byToken.set(key, [...(byToken.get(key) ?? []), miss])
  }
  const interleaved: HistoricalRequestTuple[] = []
  for (let index = 0; interleaved.length < misses.length; index += 1) {
    for (const bucket of byToken.values()) {
      if (bucket[index]) interleaved.push(bucket[index])
    }
  }
  return interleaved
}

function budgetMisses(misses: HistoricalRequestTuple[]): HistoricalRequestTuple[] {
  const closed = misses.filter((miss) => isClosedDay(miss.timestamp))
  const open = misses.filter((miss) => !isClosedDay(miss.timestamp))
  return [...interleaveByToken(closed), ...interleaveByToken(open)].slice(0, MAX_UPSTREAM_RESOLUTIONS)
}

function warn(message: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ message, ...fields }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveMisses(
  registry: HistoricalSourceRegistry,
  misses: HistoricalRequestTuple[],
  deadlineAt: number
): Promise<Resolution> {
  const targetToMiss = new Map<HistoricalPriceTarget, HistoricalRequestTuple>()
  for (const miss of budgetMisses(misses)) {
    const chainId = chainNameToId(miss.chain)
    if (chainId !== undefined) {
      targetToMiss.set({ chainId, token: miss.token, timestamp: toFetchTimestamp(miss.timestamp) }, miss)
    }
  }
  const targets = [...targetToMiss.keys()]
  const resolved: ResolvedPriceRecord[] = []
  let failed = false
  let pending = targets.length
  let accepting = true

  const onSettled = (target: HistoricalPriceTarget, entry: PromiseSettledResult<HistoricalPrice>): void => {
    const miss = targetToMiss.get(target)
    if (!accepting || !miss) return
    pending -= 1
    if (entry.status === 'fulfilled') {
      resolved.push(toResolvedRecord(miss, entry.value))
      return
    }
    if (!isNotFound(entry.reason)) failed = true
    warn('resolve-miss-failed', { ...miss, error: errorMessage(entry.reason) })
  }

  const work = registry.resolveBatch(targets, onSettled).catch((error: unknown) => {
    if (!accepting) return
    failed = true
    warn('resolve-batch-failed', { attempted: targets.length, error: errorMessage(error) })
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(true), Math.max(deadlineAt - Date.now(), 0))
    })
  ])
  clearTimeout(timeoutId)
  accepting = false

  if (timedOut) {
    failed ||= pending > 0
    warn('batch-resolution-deadline', {
      deadline_ms: REQUEST_RESOLUTION_DEADLINE_MS,
      attempted: targets.length,
      resolved: resolved.length,
      pending
    })
  }
  return { resolved, failed }
}

export async function handleBatchHistorical(
  request: Request,
  env: Env,
  pool: Pool,
  registry?: HistoricalSourceRegistry
): Promise<Response> {
  const deadlineAt = Date.now() + REQUEST_RESOLUTION_DEADLINE_MS
  const url = new URL(request.url)
  const source = parseOptionalSource(url.searchParams.get('source'))
  const rawCoins = url.searchParams.get('coins') ?? ''
  const requests = parseBatchCoins(rawCoins)
  const rows = await getBatchHistoricalPrices(pool, requests, source)

  const found = new Set(rows.map(toExactKey))
  const misses = new Map<string, HistoricalRequestTuple>()
  for (const entry of requests) {
    const key = toExactKey(entry)
    if (!found.has(key) && !misses.has(key)) misses.set(key, entry)
  }

  let failed = false
  if (!source && misses.size > 0) {
    const resolution = await resolveMisses(registry ?? historicalSourceRegistry(env), [...misses.values()], deadlineAt)
    const persisted = await persistResolvedPrices(pool, resolution.resolved)
    failed = resolution.failed || !persisted
    rows.push(...resolution.resolved)
  }

  const coins = groupRowsByToken(rows, buildOriginalKeyMap(rawCoins))
  const cacheControl = failed
    ? CACHE_CONTROL_NO_STORE
    : cacheControlForBatch(
        requests.map((entry) => entry.timestamp),
        misses.size === 0
      )
  return jsonResponse({ coins: Object.fromEntries(coins) }, { headers: { 'cache-control': cacheControl } })
}
