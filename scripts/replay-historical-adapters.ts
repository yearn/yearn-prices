import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
import { parseManifest } from '../src/backfill/manifest'
import { DefiLlamaClient } from '../src/clients/defillama'
import { SlidingWindowRateLimiter } from '../src/clients/http-client'
import { getChainClient } from '../src/clients/rpc'
import { HistoricalSourceRegistry } from '../src/registries/historical'
import { createMarketPriceResolver } from '../src/registries/market-price'
import {
  createChainlinkHistoricalSource,
  createDefiLlamaAliasHistoricalSource,
  createDefiLlamaHistoricalSource
} from '../src/sources'
import { createOnchainPriceAdapters } from '../src/sources/onchain/adapters'
import { RecursivePriceEngine } from '../src/sources/onchain/engine'
import { RecursiveDependencyError } from '../src/sources/onchain/errors'
import { DEFAULT_MAX_DEPTH, DEFAULT_READ_BUDGET } from '../src/sources/onchain/options'
import { createReadBudget } from '../src/sources/onchain/read-budget'
import type { PriceResolutionFailure, RecursivePriceTarget } from '../src/sources/onchain/types'
import { chainIdToName } from '../src/utils/chains'
import { BatchedHistoricalClient, type CoinTarget } from './lib/batched-historical-client'
import { prefetchHistoricalFrontiers } from './lib/historical-frontiers'
import { replayGraph } from './lib/graph-replay'

// Diagnostic only: no database client, persistence API, or production write mode.
config({ quiet: true })
const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    'provider-rps': { type: 'string', default: '1' },
    'not-before': { type: 'string' },
    'no-defillama': { type: 'boolean', default: false },
    'prefetch-evidence': { type: 'string' },
    'prefetch-manifest': { type: 'string' },
    'discovery-rounds': { type: 'string', default: '8' },
    scheduler: { type: 'string', default: 'graph' },
    'max-nodes': { type: 'string', default: '32000' }
  }
})
if (!values.manifest || !values.out) throw new Error('Required: --manifest <file> --out <new JSONL file>')
const scheduler = values.scheduler
if (!['graph', 'recursive'].includes(scheduler)) throw new Error('scheduler must be graph or recursive')
const maxNodes = Number(values['max-nodes'])
if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error('max-nodes must be positive')
const concurrency = Number(values.concurrency)
const discoveryRounds = Number(values['discovery-rounds'])
if (!Number.isInteger(discoveryRounds) || discoveryRounds < 0 || discoveryRounds > 8) {
  throw new Error('discovery-rounds must be an integer from 0 to 8')
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error('concurrency must be an integer from 1 to 8')
}
const manifest = parseManifest(readFileSync(values.manifest))
const out = values.out
const notBefore = values['not-before'] ? Date.parse(values['not-before']) : Date.now()
if (!Number.isFinite(notBefore)) throw new Error('not-before must be an ISO timestamp')
const providerRps = Number(values['provider-rps'])
if (!Number.isInteger(providerRps) || providerRps < 1 || providerRps > 10) {
  throw new Error('provider-rps must be an integer from 1 to 10')
}
let providerCooldownUntil = 0
let providerRetries = 0
class OfflineRateLimiter extends SlidingWindowRateLimiter {
  override async waitTurn() {
    while (providerCooldownUntil > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, providerCooldownUntil - Date.now()))
    }
    await super.waitTurn()
    if (providerCooldownUntil > Date.now()) await this.waitTurn()
  }
}
const provider = values['no-defillama']
  ? null
  : new BatchedHistoricalClient(
      new DefiLlamaClient(
        new OfflineRateLimiter(providerRps, 1000),
        (_attempt, delay, _url, status) => {
          providerRetries += 1
          if (status === 429) {
            providerCooldownUntil = Math.max(providerCooldownUntil, Date.now() + Math.max(delay, 60_000))
          }
        },
        { timeoutMs: 10_000, retryRateLimits: true, honorRetryAfter: true, retryAfterCapMs: 43_200_000 }
      )
    )
const marketSources = [
  ...(provider ? [createDefiLlamaHistoricalSource(provider)] : []),
  createChainlinkHistoricalSource(),
  ...(provider ? [createDefiLlamaAliasHistoricalSource(provider)] : [])
]
const prefetchTargets: CoinTarget[] = manifest.targets.map((target) => ({
  coin: `${chainIdToName(target.chainId)}:${target.token.toLowerCase()}`,
  timestamp: target.eodTimestamp
}))
if (provider && values['prefetch-manifest']) {
  const children = parseManifest(readFileSync(values['prefetch-manifest']))
  for (const target of children.targets) {
    prefetchTargets.push({
      coin: `${chainIdToName(target.chainId)}:${target.tokenLowercase}`,
      timestamp: target.eodTimestamp
    })
  }
}
if (provider && values['prefetch-evidence']) {
  const rootKeys = new Set(
    manifest.targets.map((target) => `${target.chainId}:${target.tokenLowercase}:${target.eodTimestamp}`)
  )
  for (const line of readFileSync(values['prefetch-evidence'], 'utf8').trim().split('\n')) {
    const record = JSON.parse(line)
    if (
      record.type !== 'target' ||
      !rootKeys.has(
        `${record.target.chainId}:${record.target.token.toLowerCase()}:${record.target.timestamp}`
      )
    )
      continue
    for (const attempt of record.marketAttempts ?? []) {
      if (attempt.source === 'defillama')
        prefetchTargets.push({
          coin: `${chainIdToName(attempt.chainId)}:${attempt.token.toLowerCase()}`,
          timestamp: attempt.timestamp
        })
    }
  }
}
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|URL|URI/.test(key) && value && value.length >= 8)
  .map(([, value]) => value as string)

function clean(message: string): string {
  let result = message.replace(/https?:\/\/[^\s"'<>]+/g, '[redacted-url]')
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]')
  return result.slice(0, 4000)
}

function failureEvidence(failure: PriceResolutionFailure): unknown {
  return {
    reason: failure.reason,
    token: failure.token,
    attempts: failure.attempts.map((attempt) => ({
      adapter: attempt.adapter,
      reason: attempt.reason,
      error: clean(attempt.error),
      ...(attempt.cause instanceof RecursiveDependencyError
        ? { dependency: failureEvidence(attempt.cause.failure) }
        : {})
    }))
  }
}

writeFileSync(
  out,
  `${JSON.stringify({
    type: 'run',
    mode: 'read-only-candidate-replay',
    startedAt: new Date().toISOString(),
    notBefore: new Date(notBefore).toISOString(),
    codeRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    manifestDigest: manifest.digest,
    targets: manifest.targets.length,
    concurrency,
    scheduler,
    maxNodes,
    discoveryRounds: scheduler === 'recursive' && provider ? discoveryRounds : 0,
    providerRps,
    defillamaEnabled: provider !== null,
    defillamaEndpoint: provider ? '/batchHistorical' : null,
    prefetchUniqueTargets: provider
      ? new Set(prefetchTargets.map((target) => `${target.coin}:${target.timestamp}`)).size
      : 0,
    providerTimeoutMs: 10_000,
    sharedCooldownOn429: 'Provider Retry-After, minimum 60 seconds, maximum 12 hours',
    readBudgetPerTarget: scheduler === 'recursive' ? DEFAULT_READ_BUDGET : null,
    readBudgetPerNode: scheduler === 'graph' ? DEFAULT_READ_BUDGET : null,
    maxDepth: DEFAULT_MAX_DEPTH,
    resolutionBudgetPerTarget: scheduler === 'recursive' ? 32 : null,
    marketSources: marketSources.map((source) => source.name),
    note: provider
      ? 'Batched market observations matched with the existing 6h matcher; shared cache and offline retries. Market sources precede the unchanged adapter graph. Candidate success is not EOD certification. No DB writes.'
      : 'DeFiLlama, its aliases, and its caches disabled. Chainlink and unchanged on-chain adapters only. No DB writes.'
  })}\n`,
  { flag: 'wx' }
)

async function replay(entry: (typeof manifest.targets)[number]) {
  const started = Date.now()
  const target = { chainId: entry.chainId, token: entry.token, timestamp: entry.eodTimestamp }
  const marketAttempts: unknown[] = []
  const adapterAttempts: unknown[] = []
  const sources = marketSources.map((source) => ({
    name: source.name,
    priority: source.priority,
    supports: (chainId: number) => source.supports(chainId),
    async getHistoricalPrice(chainId: number, token: string, timestamp: number) {
      try {
        const quote = await source.getHistoricalPrice(chainId, token, timestamp)
        marketAttempts.push({ chainId, token, timestamp, source: source.name, quote })
        return quote
      } catch (error) {
        marketAttempts.push({
          chainId,
          token,
          timestamp,
          source: source.name,
          error: clean(error instanceof Error ? error.message : String(error))
        })
        throw error
      }
    }
  }))
  const registry = new HistoricalSourceRegistry(sources)
  const market = createMarketPriceResolver(
    sources,
    (chainId, token, timestamp) => registry.resolve(chainId, token, timestamp as number),
    { requireTimestamp: true }
  )
  let rootError: string | null = null
  let path = null
  let failure: unknown = null
  let status = 'unresolved'
  const readBudget = createReadBudget(DEFAULT_READ_BUDGET)
  try {
    path = await market(target)
  } catch (error) {
    rootError = clean(error instanceof Error ? error.message : String(error))
  }
  if (path) {
    status = 'candidate-market'
  } else {
    const client = getChainClient(entry.chainId)
    if (!client) {
      status = 'missing-rpc'
    } else {
      const metered = readBudget.meter(client)
      const adapters = createOnchainPriceAdapters({
        clientForChain: (chainId) => (chainId === entry.chainId ? metered : null),
        blockContextCache: new Map()
      }).map((adapter) => ({
        name: adapter.name,
        async resolve(...args: Parameters<typeof adapter.resolve>) {
          try {
            const quote = await adapter.resolve(...args)
            adapterAttempts.push({
              target: args[0],
              adapter: adapter.name,
              outcome: quote ? 'quote' : 'not-applicable'
            })
            return quote
          } catch (error) {
            adapterAttempts.push({
              target: args[0],
              adapter: adapter.name,
              outcome: 'error',
              error: clean(error instanceof Error ? error.message : String(error))
            })
            throw error
          }
        }
      }))
      // Fresh budgets/cache per root; never spend one request budget across the manifest.
      const engine = new RecursivePriceEngine(market, adapters, DEFAULT_MAX_DEPTH)
      const result = await engine.resolve(target as RecursivePriceTarget)
      path = result.path
      failure = result.failure ? failureEvidence(result.failure) : null
      status = path ? 'candidate-adapter' : (result.failure?.reason ?? 'unresolved')
      if (!path && rootError) status = 'retryable'
    }
  }
  return {
    type: 'target',
    target,
    status,
    path,
    failure,
    rootError,
    marketAttempts,
    adapterAttempts,
    onchainReads: readBudget.spent,
    elapsedMs: Date.now() - started
  }
}

let cursor = 0
let completed = 0
const counts: Record<string, number> = {}
while (Date.now() < notBefore) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(notBefore - Date.now(), 60_000)))
}
if (provider) {
  await provider.prefetch(prefetchTargets)
  console.log(JSON.stringify({ stage: 'prefetch-complete', ...provider.stats }))
}
if (scheduler === 'graph') {
  const graph = await replayGraph({
    targets: manifest.targets.map((entry) => ({
      chainId: entry.chainId,
      token: entry.token,
      timestamp: entry.eodTimestamp
    })),
    sources: marketSources,
    provider,
    out,
    concurrency,
    maxNodes,
    clean
  })
  appendFileSync(
    out,
    `${JSON.stringify({ type: 'complete', finishedAt: new Date().toISOString(), completed: manifest.targets.length, counts: graph.counts, graph, providerRetries, batching: provider?.stats ?? null })}\n`
  )
} else {
  const discovery = provider
    ? await prefetchHistoricalFrontiers({
        provider,
        roots: manifest.targets,
        concurrency,
        maxRounds: discoveryRounds,
        probe: replay,
        onRound(round, targets) {
          const record = { type: 'discovery', round, targets, batching: { ...provider.stats } }
          appendFileSync(out, `${JSON.stringify(record)}\n`)
          console.log(JSON.stringify({ stage: 'discovery', round, targets: targets.length }))
        }
      })
    : null
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < manifest.targets.length) {
        const entry = manifest.targets[cursor++]
        const result = await replay(entry)
        appendFileSync(
          out,
          `${JSON.stringify(result, (_, value) => (typeof value === 'bigint' ? value.toString() : value))}\n`
        )
        completed += 1
        counts[result.status] = (counts[result.status] ?? 0) + 1
        console.log(
          JSON.stringify({
            completed,
            total: manifest.targets.length,
            counts,
            providerRetries,
            batching: provider?.stats ?? null
          })
        )
      }
    })
  )
  appendFileSync(
    out,
    `${JSON.stringify({ type: 'complete', finishedAt: new Date().toISOString(), completed, counts, providerRetries, discovery, batching: provider?.stats ?? null })}\n`
  )
}
