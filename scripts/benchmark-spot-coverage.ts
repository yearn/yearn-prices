import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { config as loadEnv } from 'dotenv'

import { getChainClient } from '../src/clients/rpc'
import { ApiError } from '../src/http/errors'
import { createMarketPriceResolver } from '../src/registries/market-price'
import { SpotSourceRegistry } from '../src/registries/spot'
import { createDefiLlamaSpotSource } from '../src/sources/defillama'
import { createEnsoSpotSource } from '../src/sources/enso'
import { createOnchainSpotSource } from '../src/sources/onchain'
import type { SpotPriceSource } from '../src/sources/types'
import type { Env } from '../src/types'
import { chainIdToName, chainNameToId, normalizeTokenAddress } from '../src/utils/chains'
import { nowUnix } from '../src/utils/time'
import { fetchYearnVaults } from './lib/kong-vaults'

loadEnv({ quiet: true })

export interface SpotCoverageTarget {
  chainId: number
  chain: string
  token: `0x${string}`
  label: string | null
}

export interface SpotCoverageOutcome {
  status: 'priced' | 'missing' | 'error'
  source: string | null
  category: 'direct' | 'derived' | null
  price: number | null
  timestamp: number | null
  observationEndpoint: string | null
  ageSeconds: number | null
  latencyMs: number
  errorCode: string | null
  error: string | null
}

export interface SpotCoverageComparison {
  target: SpotCoverageTarget
  baseline: SpotCoverageOutcome
  candidate: SpotCoverageOutcome
  recoveredFrom: 'missing' | 'error' | null
  disagreement: {
    absolute: number
    relativeBps: number
    sourceChanged: boolean
  } | null
}

export interface SpotCoverageReport {
  version: 1
  generatedAt: string
  request: {
    targetCount: number
    disagreementBps: number
    baselineSources: string[]
    candidateSources: string[]
  }
  cache: {
    sharedSourceInvocations: Record<string, number>
    sharedSourceCacheHits: Record<string, number>
    sharedSourceEntries: number
  }
  summary: {
    baseline: CoverageSummary
    candidate: CoverageSummary
    recovered: { total: number; fromMissing: number; fromError: number }
    disagreements: number
  }
  comparisons: SpotCoverageComparison[]
}

export interface CoverageSummary {
  total: number
  priced: number
  direct: number
  derived: number
  missing: number
  errors: number
}

interface InputTarget {
  chainId?: unknown
  chain?: unknown
  token?: unknown
  address?: unknown
  label?: unknown
  symbol?: unknown
}

interface SharedSourceCacheEntry {
  result: Promise<
    { ok: true; value: Awaited<ReturnType<SpotPriceSource['getSpotPrice']>> } | { ok: false; error: unknown }
  >
}

/**
 * Caches source-level calls shared by the baseline and candidate runs. The
 * cache stores failures as well as prices so a provider failure is not retried
 * merely because the same target appears in the second comparison.
 */
export class SharedSpotSourceCache {
  private readonly entries = new Map<string, SharedSourceCacheEntry>()
  private readonly callsBySource = new Map<string, number>()
  private readonly hitsBySource = new Map<string, number>()

  wrap(source: SpotPriceSource, shared = true): SpotPriceSource {
    if (!shared) return source
    return {
      name: source.name,
      priority: source.priority,
      supports: (chainId) => source.supports(chainId),
      getSpotPrice: (chainId, token, signal) => {
        const key = `${source.name}:${chainId}:${token.toLowerCase()}`
        const existing = this.entries.get(key)
        if (existing) {
          this.hitsBySource.set(source.name, (this.hitsBySource.get(source.name) ?? 0) + 1)
          return withAbortSignal(existing.result, signal).then((outcome) => {
            if (outcome.ok) return outcome.value
            throw outcome.error
          })
        }

        this.callsBySource.set(source.name, (this.callsBySource.get(source.name) ?? 0) + 1)
        // The underlying shared request intentionally does not inherit one
        // caller's abort signal. Each caller races the shared promise below;
        // an aborted baseline request must not poison the candidate cache.
        const result = Promise.resolve()
          .then(() => source.getSpotPrice(chainId, token))
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error })
          )
        this.entries.set(key, { result })
        return withAbortSignal(result, signal).then((outcome) => {
          if (outcome.ok) return outcome.value
          throw outcome.error
        })
      }
    }
  }

  report() {
    return {
      sharedSourceInvocations: Object.fromEntries([...this.callsBySource.entries()].sort()),
      sharedSourceCacheHits: Object.fromEntries([...this.hitsBySource.entries()].sort()),
      sharedSourceEntries: this.entries.size
    }
  }
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new ApiError('UNAVAILABLE', 'Benchmark request aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new ApiError('UNAVAILABLE', 'Benchmark request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function normalizeTarget(input: InputTarget, index: number): SpotCoverageTarget {
  const rawChainId = typeof input.chainId === 'number' ? input.chainId : undefined
  const chain = typeof input.chain === 'string' ? input.chain.toLowerCase() : undefined
  const chainId = rawChainId ?? (chain ? chainNameToId(chain) : undefined)
  if (chainId === undefined || !chainIdToName(chainId)) throw new Error(`target ${index}: unsupported chain`)
  const address = input.token ?? input.address
  if (typeof address !== 'string') throw new Error(`target ${index}: token/address is required`)
  const token = normalizeTokenAddress(address)
  const label = typeof input.label === 'string' ? input.label : typeof input.symbol === 'string' ? input.symbol : null
  return { chainId, chain: chainIdToName(chainId)!, token, label }
}

export function parseTargetFile(path: string): SpotCoverageTarget[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { targets?: unknown }).targets)
      ? (parsed as { targets: unknown[] }).targets
      : null
  if (!values) throw new Error(`target file ${path}: expected an array or {"targets": [...]}`)
  return dedupeTargets(values.map((value, index) => normalizeTarget(value as InputTarget, index)))
}

export async function loadDefaultTargets(): Promise<SpotCoverageTarget[]> {
  const vaults = await fetchYearnVaults()
  const targets: SpotCoverageTarget[] = []
  for (const vault of vaults) {
    if (vault.isRetired || vault.isHidden) continue
    targets.push({
      chainId: vault.chainId,
      chain: vault.chain,
      token: vault.vaultToken,
      label: vault.symbol ? `${vault.symbol}:vault` : 'vault'
    })
    targets.push({
      chainId: vault.chainId,
      chain: vault.chain,
      token: vault.underlyingToken,
      label: vault.symbol ? `${vault.symbol}:underlying` : 'underlying'
    })
  }
  return dedupeTargets(targets)
}

function dedupeTargets(targets: SpotCoverageTarget[]): SpotCoverageTarget[] {
  const map = new Map<string, SpotCoverageTarget>()
  for (const target of targets) {
    const key = `${target.chainId}:${target.token.toLowerCase()}`
    if (!map.has(key)) map.set(key, target)
  }
  return [...map.values()].sort(
    (left, right) =>
      left.chainId - right.chainId ||
      left.token.localeCompare(right.token) ||
      (left.label ?? '').localeCompare(right.label ?? '')
  )
}

function sourceNames(sources: SpotPriceSource[]): string[] {
  return sources.map((source) => source.name)
}

function outcomeFromError(started: number, error: unknown): SpotCoverageOutcome {
  const code = error instanceof ApiError ? error.code : null
  return {
    status: code === 'NOT_FOUND' ? 'missing' : 'error',
    source: null,
    category: null,
    price: null,
    timestamp: null,
    observationEndpoint: null,
    ageSeconds: null,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    errorCode: code,
    error: error instanceof Error ? error.message : String(error)
  }
}

async function resolveOne(registry: SpotSourceRegistry, target: SpotCoverageTarget): Promise<SpotCoverageOutcome> {
  const started = performance.now()
  try {
    const result = await registry.resolve(target.chainId, target.token)
    return {
      status: 'priced',
      source: result.source,
      category: result.source === 'derived' ? 'derived' : 'direct',
      price: result.price,
      timestamp: result.timestamp,
      observationEndpoint:
        result.source === 'defillama'
          ? '/prices/current'
          : result.source === 'enso'
            ? 'Enso token price'
            : 'RPC contract reads',
      ageSeconds: Math.max(0, nowUnix() - result.timestamp),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      errorCode: null,
      error: null
    }
  } catch (error) {
    return outcomeFromError(started, error)
  }
}

function summarize(outcomes: SpotCoverageOutcome[]): CoverageSummary {
  return {
    total: outcomes.length,
    priced: outcomes.filter((outcome) => outcome.status === 'priced').length,
    direct: outcomes.filter((outcome) => outcome.category === 'direct').length,
    derived: outcomes.filter((outcome) => outcome.category === 'derived').length,
    missing: outcomes.filter((outcome) => outcome.status === 'missing').length,
    errors: outcomes.filter((outcome) => outcome.status === 'error').length
  }
}

export async function runSpotCoverageBenchmark(
  targets: SpotCoverageTarget[],
  env: Env,
  disagreementBps = 100
): Promise<SpotCoverageReport> {
  const normalizedTargets = dedupeTargets(targets)
  if (!env.ENSO_API_KEY) throw new Error('ENSO_API_KEY is required for the spot benchmark')
  if (!Number.isFinite(disagreementBps) || disagreementBps < 0) {
    throw new Error('disagreementBps must be a finite non-negative number')
  }

  const cache = new SharedSpotSourceCache()
  // Construct market sources before either derived source so both recursive
  // graphs resolve children through the same cached Enso/DeFiLlama wrappers.
  const enso = cache.wrap(createEnsoSpotSource(env.ENSO_API_KEY))
  const defillama = cache.wrap(createDefiLlamaSpotSource())
  const baselineMarketSources = [enso]
  const candidateMarketSources = [enso, defillama]
  const baselineMarketRegistry = new SpotSourceRegistry(baselineMarketSources)
  const candidateMarketRegistry = new SpotSourceRegistry(candidateMarketSources)
  const baselineSources = () => {
    const marketPrice = createMarketPriceResolver(baselineMarketSources, (chainId, token, _timestamp, signal) =>
      baselineMarketRegistry.resolve(chainId, token, signal)
    )
    return [
      enso,
      createOnchainSpotSource({
        marketPrice,
        env,
        clientForChain: (chainId) => getChainClient(chainId, env)
      })
    ]
  }
  const candidateSources = () => {
    const marketPrice = createMarketPriceResolver(candidateMarketSources, (chainId, token, _timestamp, signal) =>
      candidateMarketRegistry.resolve(chainId, token, signal)
    )
    return [
      enso,
      defillama,
      createOnchainSpotSource({
        marketPrice,
        env,
        clientForChain: (chainId) => getChainClient(chainId, env)
      })
    ]
  }
  const comparisons: SpotCoverageComparison[] = []
  const baselineOutcomes: SpotCoverageOutcome[] = []
  const candidateOutcomes: SpotCoverageOutcome[] = []

  // Prefetch all known roots through the batched market source before running
  // the two registries. This gives both runs the same exact root observations
  // and lets DeFiLlama coalesce the request into provider-sized batches.
  const PREFETCH_GROUP_SIZE = 100
  for (let offset = 0; offset < normalizedTargets.length; offset += PREFETCH_GROUP_SIZE) {
    const group = normalizedTargets.slice(offset, offset + PREFETCH_GROUP_SIZE)
    await Promise.all(
      group.map(async (target) => {
        await Promise.allSettled([
          enso.getSpotPrice(target.chainId, target.token),
          defillama.getSpotPrice(target.chainId, target.token)
        ])
      })
    )
  }

  // A fresh derived source per target gives every comparison an independent
  // read/resolution budget. The market cache remains shared globally.
  for (const target of normalizedTargets) {
    const baseline = new SpotSourceRegistry(baselineSources())
    const candidate = new SpotSourceRegistry(candidateSources())
    const baselineResult = await resolveOne(baseline, target)
    const candidateResult = await resolveOne(candidate, target)
    baselineOutcomes.push(baselineResult)
    candidateOutcomes.push(candidateResult)
    const recoveredFrom =
      candidateResult.status === 'priced' && baselineResult.status !== 'priced' ? baselineResult.status : null
    let disagreement: SpotCoverageComparison['disagreement'] = null
    if (
      baselineResult.status === 'priced' &&
      candidateResult.status === 'priced' &&
      baselineResult.price &&
      candidateResult.price
    ) {
      const absolute = Math.abs(candidateResult.price - baselineResult.price)
      const relativeBps = (absolute / baselineResult.price) * 10_000
      if (relativeBps >= disagreementBps || baselineResult.source !== candidateResult.source) {
        disagreement = {
          absolute,
          relativeBps: Math.round(relativeBps * 100) / 100,
          sourceChanged: baselineResult.source !== candidateResult.source
        }
      }
    }
    comparisons.push({ target, baseline: baselineResult, candidate: candidateResult, recoveredFrom, disagreement })
  }

  const recovered = comparisons.reduce(
    (summary, comparison) => {
      if (comparison.recoveredFrom === 'missing') summary.fromMissing += 1
      if (comparison.recoveredFrom === 'error') summary.fromError += 1
      return summary
    },
    { total: 0, fromMissing: 0, fromError: 0 }
  )
  recovered.total = recovered.fromMissing + recovered.fromError
  const cacheReport = cache.report()
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    request: {
      targetCount: normalizedTargets.length,
      disagreementBps,
      baselineSources: ['enso', 'derived'],
      candidateSources: sourceNames(candidateSources())
    },
    cache: cacheReport,
    summary: {
      baseline: summarize(baselineOutcomes),
      candidate: summarize(candidateOutcomes),
      recovered,
      disagreements: comparisons.filter((comparison) => comparison.disagreement !== null).length
    },
    comparisons
  }
}

function renderHtml(report: SpotCoverageReport): string {
  const escaped = JSON.stringify(report).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const rows = report.comparisons
    .map(
      (comparison) =>
        `<tr><td>${comparison.target.chain}:${comparison.target.token}</td><td>${comparison.baseline.status}</td><td>${comparison.baseline.source ?? ''}</td><td>${comparison.candidate.status}</td><td>${comparison.candidate.source ?? ''}</td><td>${comparison.recoveredFrom ?? ''}</td><td>${comparison.disagreement?.relativeBps.toFixed(2) ?? ''}</td></tr>`
    )
    .join('')
  return `<!doctype html><meta charset="utf-8"><title>Spot coverage benchmark</title><style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem;text-align:left}pre{white-space:pre-wrap}</style><h1>Spot coverage benchmark</h1><p>Targets: ${report.request.targetCount}; recovered: ${report.summary.recovered.total}; disagreements: ${report.summary.disagreements}</p><table><thead><tr><th>Target</th><th>Baseline</th><th>Source</th><th>Candidate</th><th>Source</th><th>Recovered from</th><th>Delta (bps)</th></tr></thead><tbody>${rows}</tbody></table><details><summary>Machine-readable report</summary><pre>${escaped}</pre></details>`
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      targets: { type: 'string' },
      out: { type: 'string' },
      html: { type: 'string' },
      limit: { type: 'string' },
      'disagreement-bps': { type: 'string' }
    }
  })
  const targets = values.targets ? parseTargetFile(values.targets) : await loadDefaultTargets()
  const limit = values.limit ? Number(values.limit) : undefined
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error('--limit must be a positive integer')
  const report = await runSpotCoverageBenchmark(
    limit === undefined ? targets : targets.slice(0, limit),
    process.env as unknown as Env,
    values['disagreement-bps'] ? Number(values['disagreement-bps']) : 100
  )
  const output = JSON.stringify(report, null, 2) + '\n'
  if (values.out) writeFileSync(values.out, output)
  else process.stdout.write(output)
  if (values.html) writeFileSync(values.html, renderHtml(report))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
