import type { Pool } from '@neondatabase/serverless'
import { DefiLlamaClient } from '../../clients/defillama'
import { finalizeTokenPrices, insertProvisionalTokenPrices } from '../../db'
import { plausibleWrites, storedCurveLpGuard } from '../../prices/curve-lp-guard'
import { ACCEPTED_PRICE_SQL } from '../../prices/rejections'
import { type CurrentPriceTarget, currentPriceKey, fetchCurrentPrices } from '../../sources/defillama/current'
import { createDefiLlamaHistoricalSource } from '../../sources/defillama/historical'
import type { PlausibleQuote } from '../../sources/defillama/lp-guard'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../../sources/types'
import type { Env, ExactPriceRecord, HistoricalRequestTuple, PriceSource, TokenPriceWrite } from '../../types'
import { chainIdToName, chainNameToId } from '../../utils/chains'
import { currentUtcDayEnd, isClosedDay, isTodayNormalized } from '../../utils/time'

const UPSTREAM_TIMEOUT_MS = 2_500
// ponytail: 200 closed-day misses per request bounds subrequests and latency;
// the rest stay missing until warmup or a later read fills them.
export const MAX_READ_THROUGH_TARGETS = 200
// ponytail: at most 8 guard checks (one lp-guard wave) per read, each a pool discovery, a block estimate,
// a get_virtual_price read and one DB read; a known Curve LP's quotes past the cap stay missing for a later read.
export const MAX_GUARDED_RECORDS = 8

export interface ReadThroughUpstream {
  current: (targets: CurrentPriceTarget[]) => Promise<Map<string, HistoricalPriceResult>>
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

function logFailure(stage: 'current' | 'historical', error: unknown): void {
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
  if (todayTargets.size === 0 && closedTargets.length === 0) return { rows, upstreamFailed: false }

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

  const todayRecords: ExactPriceRecord[] = []
  const closedRecords: ExactPriceRecord[] = []
  const toRecord = (
    chain: string,
    token: string,
    timestamp: number,
    price: HistoricalPriceResult,
    endpoint: string
  ): ExactPriceRecord => ({
    chain,
    token,
    timestamp,
    price: price.price,
    symbol: price.symbol,
    confidence: price.confidence,
    source: 'defillama',
    observedTimestamp: price.timestamp,
    observationEndpoint: endpoint
  })

  for (const [key, { chain, token }] of todayTargets) {
    const price = live.get(key)
    if (!price) continue
    const observed = stored.get(exactKey(chain, token, todayEnd))?.observedTimestamp
    if (observed != null && observed >= price.timestamp) continue
    todayRecords.push(toRecord(chain, token, todayEnd, price, '/prices/current'))
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

  return {
    rows: [...rows.filter((row) => !replaced.has(exactKey(row.chain, row.token, row.timestamp))), ...fetched],
    upstreamFailed
  }
}
