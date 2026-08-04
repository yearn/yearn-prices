import { config as loadEnv } from 'dotenv'
import { runDailyPriceWorker } from '../src/daily-price-worker'
import { createPool } from '../src/db'
import { createHistoricalMarketPriceResolver } from '../src/historical-market'
import { createOnchainPriceAdapters } from '../src/onchain-price-adapters'
import { RecursivePriceEngine } from '../src/recursive-pricing'
import { getChainClient, validateConfiguredRpcChainIds } from '../src/rpc'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

interface CliOptions {
  batchSize?: number
  concurrency?: number
  maxTargets?: number
  leaseSeconds?: number
  maxAttempts?: number
  retryDelaySeconds?: number
  progressEvery?: number
  maxDepth?: number
  searchWidth?: string
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === '--batch-size') options.batchSize = parsePositiveInteger(value, flag)
    else if (flag === '--concurrency') options.concurrency = parsePositiveInteger(value, flag)
    else if (flag === '--max-targets') options.maxTargets = parsePositiveInteger(value, flag)
    else if (flag === '--lease-seconds') options.leaseSeconds = parsePositiveInteger(value, flag)
    else if (flag === '--max-attempts') options.maxAttempts = parsePositiveInteger(value, flag)
    else if (flag === '--retry-delay-seconds') options.retryDelaySeconds = parsePositiveInteger(value, flag)
    else if (flag === '--progress-every') options.progressEvery = parsePositiveInteger(value, flag)
    else if (flag === '--max-depth') options.maxDepth = parsePositiveInteger(value, flag)
    else if (flag === '--search-width') {
      if (!value) throw new Error(`${flag} requires a value such as 6h`)
      options.searchWidth = value
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
    index += 1
  }
  return options
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid non-negative number: ${value}`)
  return parsed
}

function optionalInteger(value: string | undefined, name: string, minimum: number): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer no smaller than ${minimum}`)
  }
  return parsed
}


const options = parseOptions(process.argv.slice(2))
const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)

try {
  const disagreementThresholdBps = optionalNumber(process.env.PRICE_DISAGREEMENT_THRESHOLD_BPS)
  const disagreementWindowSeconds = optionalNumber(process.env.PRICE_DISAGREEMENT_WINDOW_SECONDS)
  const marketPrice = createHistoricalMarketPriceResolver(pool, {
    searchWidth: options.searchWidth,
    disagreementThresholdBps,
    disagreementWindowSeconds,
    batchSize: optionalInteger(process.env.PRICE_MARKET_BATCH_SIZE, 'PRICE_MARKET_BATCH_SIZE', 1),
    batchConcurrency: optionalInteger(
      process.env.PRICE_MARKET_BATCH_CONCURRENCY,
      'PRICE_MARKET_BATCH_CONCURRENCY',
      1,
    ),
    batchDelayMs: optionalInteger(process.env.PRICE_MARKET_BATCH_DELAY_MS, 'PRICE_MARKET_BATCH_DELAY_MS', 0),
  })
  const adapters = createOnchainPriceAdapters({
    clientForChain: getChainClient,
    pendleTwapSeconds: optionalNumber(process.env.PRICE_PENDLE_TWAP_SECONDS),
  })
  const resolver = new RecursivePriceEngine(marketPrice, adapters, options.maxDepth, {
    disagreementThresholdBps,
    disagreementWindowSeconds,
  })
  const summary = await runDailyPriceWorker(pool, resolver, {
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    maxTargets: options.maxTargets,
    leaseSeconds: options.leaseSeconds,
    maxAttempts: options.maxAttempts,
    retryDelaySeconds: options.retryDelaySeconds,
    progressEvery: options.progressEvery,
    onProgress: progress => console.info(JSON.stringify({
      message: 'daily-price-progress',
      ...progress,
    })),
  }, {
    validateConfiguration: () => validateConfiguredRpcChainIds(),
  })
  console.info(JSON.stringify({ message: 'daily-price-complete', ...summary }))
} finally {
  await pool.end()
}
