import type { Pool } from '@neondatabase/serverless'
import { DefiLlamaClient } from '../../clients/defillama'
import { enqueueClosedRepairTargets, finalizeTokenPrices, insertProvisionalTokenPrices } from '../../db'
import type { RepairTarget } from '../../db/repair-queue'
import { plausibleWrites, storedCurveLpGuard } from '../../prices/curve-lp-guard'
import { ACCEPTED_PRICE_SQL } from '../../prices/rejections'
import { type CurrentPriceTarget, currentPriceKey, fetchCurrentPrices } from '../../sources/defillama/current'
import { createDefiLlamaHistoricalSource } from '../../sources/defillama/historical'
import type { PlausibleQuote } from '../../sources/defillama/lp-guard'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../../sources/types'
import {
  resolveCurrentFallback,
  type CurrentFallbackResult,
  type CurrentFallbackTarget
} from '../../sources/onchain/current-fallback'
import type { Env, ExactPriceRecord, HistoricalRequestTuple, PriceSource, TokenPriceWrite } from '../../types'
import { chainIdToName, chainNameToId } from '../../utils/chains'
import { currentUtcDayEnd, isClosedDay, isTodayNormalized } from '../../utils/time'

const UPSTREAM_TIMEOUT_MS = 2_500
// ponytail: 200 closed-day misses per request bounds subrequests and latency;
// the rest stay missing until warmup or a later read fills them.
export const MAX_READ_THROUGH_TARGETS = 200
// Current fallback is intentionally smaller than the historical read-through:
// Chainlink and recursive RPC reads are per-token and must stay inside the
// request deadline.
export const MAX_CURRENT_FALLBACK_TARGETS = 8
// ponytail: at most 8 guard checks (one lp-guard wave) per read, each a pool discovery, a block estimate,
// a get_virtual_price read and one DB read; a known Curve LP's quotes past the cap stay missing for a later read.
export const MAX_GUARDED_RECORDS = 8

export interface ReadThroughUpstream {
  current: (targets: CurrentPriceTarget[]) => Promise<Map<string, HistoricalPriceResult>>
  currentFallback?: (
    targets: CurrentFallbackTarget[],
    cached: Map<string, HistoricalPriceResult>
  ) => Promise<CurrentFallbackResult>
  historical: (targets: HistoricalPriceTarget[]) => Promise<{ prices: HistoricalBatchPrice[]; failed: boolean }>
  guard?: PlausibleQuote
}

const client = () =>
  new DefiLlamaClient(undefined, undefined, { timeoutMs: UPSTREAM_TIMEOUT_MS, retryRateLimits: false })

const defaultUpstream: ReadThroughUpstream = {
  current: (targets) => fetchCurrentPrices(client(), targets),
  historical: async (targets) => {
    let failed = false
    const prices = await createDefiLlamaHistoricalSource(client()).getBatchHistoricalPrices(
      targets,
      undefined,
      (_settled, error) => {
        if (error) failed = true
      }
    )
    return { prices, failed }
  }
}

const exactKey = (chain: string, token: string, timestamp: number) => `${chain}:${token.toLowerCase()}:${timestamp}`

function logFailure(stage: 'current' | 'historical' | 'current-fallback' | 'repair-queue', error: unknown): void {
  console.error(JSON.stringify({ message: 'read-through-failed', stage, error: String(error) }))
}

async function knownCurveLps(pool: Pool, records: ExactPriceRecord[]): Promise<Set<string>> {
  if (records.length === 0) return new Set()
  const pairs = new Map(records.map((record) => [lpKey(record.chain, record.token), record]))
  const { rows } = await pool.query<{ chain: string; token: string }>(
    `SELECT p.chain, p.token FROM unnest($1::text[], $2::text[]) AS p(chain, token)
     WHERE EXISTS (
       SELECT 1 FROM token_prices tp
       WHERE tp.chain = p.chain AND tp.token = p.token AND tp.source = 'curve' AND ${ACCEPTED_PRICE_SQL}
     )`,
    [[...pairs.values()].map((record) => record.chain), [...pairs.values()].map((record) => record.token)]
  )
  return new Set(rows.map((row) => lpKey(row.chain, row.token)))
}

const lpKey = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`

async function queueClosedDayRepairs(pool: Pool, requests: HistoricalRequestTuple[]): Promise<void> {
  const closed = [
    ...new Map(
      requests
        .filter((request) => isClosedDay(request.timestamp))
        .map((request) => [exactKey(request.chain, request.token, request.timestamp), request])
    ).values()
  ].slice(0, MAX_READ_THROUGH_TARGETS)
  if (closed.length === 0) return

  try {
    // A provisional row is intentionally not sufficient here. The shared
    // helper checks accepted finalized observations and preserves retry state.
    const targets: RepairTarget[] = closed.flatMap((request) => {
      const chainId = chainNameToId(request.chain)
      return chainId === undefined ? [] : [{ chainId, token: request.token, timestamp: request.timestamp }]
    })
    await enqueueClosedRepairTargets(pool, targets)
  } catch (error) {
    logFailure('repair-queue', error)
  }
}

export async function readThrough(
  pool: Pool,
  env: Env,
  requests: HistoricalRequestTuple[],
  rows: ExactPriceRecord[],
  source: PriceSource | undefined,
  upstream: ReadThroughUpstream = defaultUpstream
): Promise<{ rows: ExactPriceRecord[]; upstreamFailed: boolean }> {
  if (source) return { rows, upstreamFailed: false }

  const todayEnd = currentUtcDayEnd()
  const stored = new Map(rows.map((row) => [exactKey(row.chain, row.token, row.timestamp), row]))
  const todayTargets = new Map<string, CurrentPriceTarget>()
  const missing = new Map<string, HistoricalRequestTuple>()
  for (const request of requests) {
    const key = exactKey(request.chain, request.token, request.timestamp)
    if (isTodayNormalized(request.timestamp)) {
      todayTargets.set(currentPriceKey(request.chain, request.token), { chain: request.chain, token: request.token })
    } else if (isClosedDay(request.timestamp) && !stored.has(key)) {
      missing.set(key, request)
    }
  }
  const closedTargets = [...missing.values()].slice(0, MAX_READ_THROUGH_TARGETS).flatMap((request) => {
    const chainId = chainNameToId(request.chain)
    return chainId === undefined ? [] : [{ chainId, token: request.token, timestamp: request.timestamp }]
  })
  if (todayTargets.size === 0 && closedTargets.length === 0) {
    await queueClosedDayRepairs(pool, requests)
    return { rows, upstreamFailed: false }
  }

  let upstreamFailed = false
  const [live, closed] = await Promise.all([
    todayTargets.size === 0
      ? new Map<string, HistoricalPriceResult>()
      : upstream.current([...todayTargets.values()]).catch((error) => {
          upstreamFailed = true
          logFailure('current', error)
          return new Map<string, HistoricalPriceResult>()
        }),
    closedTargets.length === 0
      ? []
      : upstream.historical(closedTargets).then(
          (result) => {
            if (result.failed) upstreamFailed = true
            return result.prices
          },
          (error) => {
            upstreamFailed = true
            logFailure('historical', error)
            return []
          }
        )
  ])

  const fallbackTargets = [...todayTargets.entries()]
    .filter(([key]) => !live.has(key))
    .slice(0, MAX_CURRENT_FALLBACK_TARGETS)
  let fallback: CurrentFallbackResult = { prices: new Map(), failed: false }
  if (fallbackTargets.length > 0 && (upstream.currentFallback || upstream === defaultUpstream)) {
    const targets: CurrentFallbackTarget[] = fallbackTargets.map(([, target]) => ({
      chainId: chainNameToId(target.chain) ?? 0,
      chain: target.chain,
      token: target.token
    }))
    try {
      fallback = upstream.currentFallback
        ? await upstream.currentFallback(targets, live)
        : await resolveCurrentFallback(
            env,
            targets.filter((target) => target.chainId > 0),
            live
          )
      if (fallback.failed) upstreamFailed = true
    } catch (error) {
      upstreamFailed = true
      logFailure('current-fallback', error)
    }
  }

  const todayRecords: ExactPriceRecord[] = []
  const closedRecords: ExactPriceRecord[] = []
  const toRecord = (
    chain: string,
    token: string,
    timestamp: number,
    price: HistoricalPriceResult,
    endpoint: string,
    source: PriceSource = 'defillama'
  ): ExactPriceRecord => ({
    chain,
    token,
    timestamp,
    price: price.price,
    symbol: price.symbol,
    confidence: price.confidence,
    source,
    observedTimestamp: price.timestamp,
    observationEndpoint: endpoint
  })

  for (const [key, { chain, token }] of todayTargets) {
    const price = live.get(key)
    if (!price) continue
    const observed = stored.get(exactKey(chain, token, todayEnd))?.observedTimestamp
    if (observed != null && observed > price.timestamp) continue
    todayRecords.push(toRecord(chain, token, todayEnd, price, '/prices/current'))
  }

  for (const [, { chain, token }] of fallbackTargets) {
    const price = fallback.prices.get(currentPriceKey(chain, token))
    if (!price) continue
    const observed = stored.get(exactKey(chain, token, todayEnd))?.observedTimestamp
    if (observed != null && observed >= price.timestamp) continue
    todayRecords.push(toRecord(chain, token, todayEnd, price, price.observationEndpoint, price.source))
  }

  for (const { target, price } of closed) {
    const chain = chainIdToName(target.chainId)
    const request = chain && missing.get(exactKey(chain, target.token, target.timestamp))
    if (!request) continue
    closedRecords.push(toRecord(request.chain, request.token, request.timestamp, price, '/batchHistorical'))
  }

  // ponytail: only known Curve LPs (an accepted `curve` row exists) are guarded, to avoid an RPC per fetched token.
  // Unguarded closed days are stored provisional, so warmup/backfill re-resolve them through the guard.
  const lps = await knownCurveLps(pool, [...todayRecords, ...closedRecords])
  const candidates = [...todayRecords, ...closedRecords].filter((record) => lps.has(lpKey(record.chain, record.token)))
  const checked = candidates.slice(0, MAX_GUARDED_RECORDS)
  const guarded = new Set<object>(checked)
  const dropped = new Set<object>(candidates.slice(MAX_GUARDED_RECORDS))
  if (checked.length > 0) {
    const { rejected } = await plausibleWrites(checked, upstream.guard ?? storedCurveLpGuard(pool, env))
    for (const record of rejected) dropped.add(record)
  }
  const fetched = [...todayRecords, ...closedRecords].filter((record) => !dropped.has(record))
  const closedWrites = closedRecords.filter((record) => guarded.has(record) && !dropped.has(record))
  const writes: TokenPriceWrite[] = fetched
    .filter((record) => !closedWrites.includes(record))
    .map((record) => ({ ...record, finalizationIntent: 'provisional' }))
  const replaced = new Set(fetched.map((record) => exactKey(record.chain, record.token, record.timestamp)))

  try {
    await insertProvisionalTokenPrices(pool, writes)
    await finalizeTokenPrices(pool, closedWrites)
  } catch (error) {
    console.error(JSON.stringify({ message: 'read-through-persist-failed', error: String(error) }))
  }

  // Queue after the read-through so a successful request can be persisted
  // before the repair worker sees the target. Existing provisional closed-day
  // rows are still admitted because the queue helper requires finalization.
  await queueClosedDayRepairs(pool, requests)

  return {
    rows: [...rows.filter((row) => !replaced.has(exactKey(row.chain, row.token, row.timestamp))), ...fetched],
    upstreamFailed
  }
}
