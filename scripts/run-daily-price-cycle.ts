import { config as loadEnv } from 'dotenv'
import { discoverYearnDailyTargets } from '../src/daily-target-discovery'
import { runDailyPriceWorker } from '../src/daily-price-worker'
import { enqueueDailyPriceTargets, markDailyPriceTargetsPriced } from '../src/daily-prices'
import { createPool } from '../src/db'
import { selectEodPriceEvidence } from '../src/evidence'
import { createHistoricalMarketPriceResolver } from '../src/historical-market'
import { createOnchainPriceAdapters } from '../src/onchain-price-adapters'
import { getBatchHistoricalPriceEvidenceCandidates } from '../src/queries'
import { RecursivePriceEngine } from '../src/recursive-pricing'
import { getChainClient, validateConfiguredRpcChainIds } from '../src/rpc'
import { latestClosedUtcDayEnd } from '../src/time'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

function cycleEodTimestamp(nowTimestamp = Math.floor(Date.now() / 1_000)): number {
  const configured = process.env.DAILY_EOD_DAY?.trim()
  if (!configured) return latestClosedUtcDayEnd(nowTimestamp)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(configured)) throw new Error('DAILY_EOD_DAY must use YYYY-MM-DD')
  const parsed = new Date(`${configured}T23:59:59.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== configured) {
    throw new Error('DAILY_EOD_DAY is not a valid UTC calendar date')
  }
  const timestamp = Math.floor(parsed.getTime() / 1_000)
  if (timestamp > latestClosedUtcDayEnd(nowTimestamp)) throw new Error('DAILY_EOD_DAY must be closed')
  return timestamp
}

function optionalInteger(value: string | undefined, name: string, fallback: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid non-negative number: ${value}`)
  return parsed
}

function optionalNonNegativeInteger(value: string | undefined, name: string, fallback: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

const eodTimestamp = cycleEodTimestamp()
const targets = await discoverYearnDailyTargets(eodTimestamp)
const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)

try {
  const requests = targets.map(target => ({ chain: target.chain, token: target.token, timestamp: eodTimestamp }))
  const candidates = await getBatchHistoricalPriceEvidenceCandidates(pool, requests)
  const grouped = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = `${candidate.chain}:${candidate.token.toLowerCase()}`
    grouped.set(key, [...(grouped.get(key) ?? []), candidate])
  }
  const accepted = targets.flatMap(target => {
    const selection = selectEodPriceEvidence(
      eodTimestamp,
      grouped.get(`${target.chain}:${target.token.toLowerCase()}`) ?? [],
    )
    if (!selection.selected) return []
    const selected = selection.selected
    return [{
      target: {
        ...target,
        metadata: {
          ...target.metadata,
          observedTimestamp: selected.observedTimestamp,
          observationDistance: selected.observationDistance,
          source: selected.source,
          classification: selected.classification,
          quality: selected.quality,
          candidateId: selected.candidateId,
          candidateCount: selection.candidates.length,
          candidateIds: selection.candidates.map(candidate => candidate.candidateId),
          adapterVersion: selected.metadata.adapterVersion ?? null,
          policyVersion: selected.metadata.policyVersion ?? null,
        },
      },
      adapter: selected.adapter ?? selected.source,
    }]
  })

  const inserted = await enqueueDailyPriceTargets(pool, targets)
  let markedPriced = 0
  const acceptedByAdapter = new Map<string, typeof accepted>()
  for (const item of accepted) {
    acceptedByAdapter.set(item.adapter, [...(acceptedByAdapter.get(item.adapter) ?? []), item])
  }
  for (const [adapter, items] of acceptedByAdapter) {
    markedPriced += await markDailyPriceTargetsPriced(pool, items.map(item => item.target), adapter)
  }

  const disagreementThresholdBps = optionalNumber(process.env.PRICE_DISAGREEMENT_THRESHOLD_BPS)
  const disagreementWindowSeconds = optionalNumber(process.env.PRICE_DISAGREEMENT_WINDOW_SECONDS)
  const marketPrice = createHistoricalMarketPriceResolver(pool, {
    searchWidth: process.env.PRICE_SEARCH_WIDTH ?? '6h',
    disagreementThresholdBps,
    disagreementWindowSeconds,
    batchSize: optionalInteger(process.env.PRICE_MARKET_BATCH_SIZE, 'PRICE_MARKET_BATCH_SIZE', 75),
    batchConcurrency: optionalInteger(process.env.PRICE_MARKET_BATCH_CONCURRENCY, 'PRICE_MARKET_BATCH_CONCURRENCY', 1),
    batchDelayMs: optionalNonNegativeInteger(process.env.PRICE_MARKET_BATCH_DELAY_MS, 'PRICE_MARKET_BATCH_DELAY_MS', 250),
  })
  const adapters = createOnchainPriceAdapters({ clientForChain: getChainClient })
  const resolver = new RecursivePriceEngine(
    marketPrice,
    adapters,
    optionalInteger(process.env.PRICE_MAX_DEPTH, 'PRICE_MAX_DEPTH', 6),
    { disagreementThresholdBps, disagreementWindowSeconds },
  )
  const worker = await runDailyPriceWorker(pool, resolver, {
    batchSize: optionalInteger(process.env.PRICE_WORKER_BATCH_SIZE, 'PRICE_WORKER_BATCH_SIZE', 50),
    concurrency: optionalInteger(process.env.PRICE_WORKER_CONCURRENCY, 'PRICE_WORKER_CONCURRENCY', 8),
    leaseSeconds: optionalInteger(process.env.PRICE_WORKER_LEASE_SECONDS, 'PRICE_WORKER_LEASE_SECONDS', 300),
    maxAttempts: optionalInteger(process.env.PRICE_WORKER_MAX_ATTEMPTS, 'PRICE_WORKER_MAX_ATTEMPTS', 3),
    retryDelaySeconds: optionalInteger(process.env.PRICE_WORKER_RETRY_DELAY_SECONDS, 'PRICE_WORKER_RETRY_DELAY_SECONDS', 300),
  }, { validateConfiguration: () => validateConfiguredRpcChainIds() })

  console.info(JSON.stringify({
    message: 'daily-price-cycle-complete',
    eodTimestamp,
    discoveredTargets: targets.length,
    inserted,
    alreadyAccepted: accepted.length,
    markedPriced,
    worker,
  }))
  if (worker.progress.remaining !== 0) throw new Error(`Daily price cycle ended with ${worker.progress.remaining} remaining targets`)
} finally {
  await pool.end()
}
