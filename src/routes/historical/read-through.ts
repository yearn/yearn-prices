import type { Pool } from '@neondatabase/serverless'
import { DefiLlamaClient } from '../../clients/defillama'
import { finalizeTokenPrices, insertProvisionalTokenPrices } from '../../db'
import { type CurrentPriceTarget, currentPriceKey, fetchCurrentPrices } from '../../sources/defillama/current'
import { createDefiLlamaHistoricalSource } from '../../sources/defillama/historical'
import type { HistoricalBatchPrice, HistoricalPriceResult, HistoricalPriceTarget } from '../../sources/types'
import type { ExactPriceRecord, HistoricalRequestTuple, PriceSource, TokenPriceWrite } from '../../types'
import { chainIdToName, chainNameToId } from '../../utils/chains'
import { currentUtcDayEnd, isClosedDay, isTodayNormalized } from '../../utils/time'

const UPSTREAM_TIMEOUT_MS = 2_500
// ponytail: 200 closed-day misses per request bounds subrequests and latency;
// the rest stay missing until warmup or a later read fills them.
export const MAX_READ_THROUGH_TARGETS = 200

export interface ReadThroughUpstream {
  current: (targets: CurrentPriceTarget[]) => Promise<Map<string, HistoricalPriceResult>>
  historical: (targets: HistoricalPriceTarget[]) => Promise<{ prices: HistoricalBatchPrice[]; failed: boolean }>
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

export async function readThrough(
  pool: Pool,
  requests: HistoricalRequestTuple[],
  rows: ExactPriceRecord[],
  source: PriceSource | undefined,
  upstream: ReadThroughUpstream = defaultUpstream
): Promise<{ rows: ExactPriceRecord[]; upstreamFailed: boolean }> {
  if (source) return { rows, upstreamFailed: false }

  const todayEnd = currentUtcDayEnd()
  const stored = new Set(rows.map((row) => exactKey(row.chain, row.token, row.timestamp)))
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

  const fetched: ExactPriceRecord[] = []
  const writes: TokenPriceWrite[] = []
  const closedWrites: TokenPriceWrite[] = []
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
    const record = toRecord(chain, token, todayEnd, price, '/prices/current')
    fetched.push(record)
    writes.push({ ...record, finalizationIntent: 'provisional' })
  }
  const replaced = new Set(fetched.map((record) => exactKey(record.chain, record.token, record.timestamp)))

  for (const { target, price } of closed) {
    const chain = chainIdToName(target.chainId)
    const request = chain && missing.get(exactKey(chain, target.token, target.timestamp))
    if (!request) continue
    const record = toRecord(request.chain, request.token, request.timestamp, price, '/batchHistorical')
    fetched.push(record)
    closedWrites.push(record)
  }

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
