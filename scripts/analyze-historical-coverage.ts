import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
import { classifyCoverage, dateOf, ranges, validateCoverageChart } from '../src/backfill/coverage'
import { validateGraphResolution } from '../src/backfill/graph-validation'
import { needsOwnPricing } from '../src/backfill/investigation'
import {
  DEFI_LLAMA_SEARCH_WIDTH,
  DEFI_LLAMA_SEARCH_WIDTH_SECONDS,
  type DefiLlamaClient
} from '../src/clients/defillama'
import { createPool } from '../src/db'
import { getDefiLlamaCoinGeckoAlias, isDefiLlamaAliasValidAt } from '../src/sources/defillama/aliases'
import { type DefiLlamaSample, matchPricesToRequests } from '../src/sources/defillama/match'
import type { GraphNode } from '../src/sources/onchain/graph'
import { chainIdToName } from '../src/utils/chains'
import { createOfflineDefiLlamaClient } from './lib/offline-provider'

interface Asset {
  chainId: number
  token: string
  symbol?: string
  observations: Array<{ date: string; status: string; pricingNeed?: string }>
}
const DAY = 86400
config({ quiet: true })
const { values } = parseArgs({
  options: {
    inventory: { type: 'string' },
    graph: { type: 'string' },
    out: { type: 'string' },
    start: { type: 'string', default: '2015-07-30' },
    end: { type: 'string' }
  }
})
if (!values.inventory || !values.out || !values.end)
  throw new Error('Required: --inventory --out <directory> --end YYYY-MM-DD')
const start = Date.parse(values.start) / 1000 + DAY - 1
const end = Date.parse(values.end) / 1000 + DAY - 1
if (
  !Number.isSafeInteger(start) ||
  !Number.isSafeInteger(end) ||
  start > end ||
  end >= Math.floor(Date.now() / 1000 / DAY) * DAY
)
  throw new Error('Use a valid closed-day interval')
const assets: Asset[] = JSON.parse(readFileSync(values.inventory, 'utf8')).assets.filter((asset: Asset) =>
  asset.observations.some(needsOwnPricing)
)
const out = resolve(values.out)
mkdirSync(out, { recursive: true })
const pool = createPool(process.env.DATABASE_URL!)
const state = new Map<
  string,
  {
    asset: Asset
    stored: number[]
    storedAny: { first: number | null; last: number | null; rows: number }
    provider: number[]
    failed: number[]
    alias: number[]
    symbol?: string
  }
>()
for (const asset of assets) {
  const key = asset.chainId + ':' + asset.token.toLowerCase()
  state.set(key, {
    asset,
    stored: [],
    storedAny: { first: null, last: null, rows: 0 },
    provider: [],
    failed: [],
    alias: []
  })
}
try {
  // One read per asset returns aggregated dates, not full price rows.
  for (const item of state.values()) {
    const result = await pool.query(
      `
      SELECT min(extract(epoch from timestamp)) AS first,
             max(extract(epoch from timestamp)) AS last, count(*) AS rows,
             array_agg(DISTINCT extract(epoch from timestamp)::bigint)
               FILTER (WHERE mod(extract(epoch from timestamp)::bigint, 86400) = 86399) AS days
      FROM token_prices WHERE chain = $1 AND lower(token) = $2
        AND price > 0 AND timestamp <= to_timestamp($3)
    `,
      [chainIdToName(item.asset.chainId), item.asset.token.toLowerCase(), end]
    )
    const row = result.rows[0]
    item.stored = (row.days ?? []).map(Number)
    item.storedAny = {
      first: row.first == null ? null : Number(row.first),
      last: row.last == null ? null : Number(row.last),
      rows: Number(row.rows)
    }
  }
} finally {
  await pool.end()
}

let retries = 0
const provider = createOfflineDefiLlamaClient(1, {
  timeoutMs: 30000,
  onRetry: () => {
    retries++
  }
})
const identifiers = [
  ...new Set(
    assets.flatMap((asset) => {
      const chain = chainIdToName(asset.chainId)!
      const alias = getDefiLlamaCoinGeckoAlias(chain, asset.token)
      return [chain + ':' + asset.token.toLowerCase(), ...(alias ? [alias.identifier] : [])]
    })
  )
]
const matchedByCoin = new Map<string, Map<number, DefiLlamaSample>>()
const invalidByCoin = new Map<string, Set<number>>()
const failedByCoin = new Map<string, Set<number>>()
let requests = 0
const firstByCoin = new Map<string, number | null>()
for (let offset = 0; offset < identifiers.length; offset += 5) {
  const coins = identifiers.slice(offset, offset + 5)
  const key = createHash('sha256').update(JSON.stringify(coins)).digest('hex')
  const file = resolve(out, 'first-' + key + '.json')
  try {
    let response: Awaited<ReturnType<DefiLlamaClient['getFirst']>>
    if (existsSync(file)) response = JSON.parse(readFileSync(file, 'utf8'))
    else {
      requests++
      response = await provider.getFirst(coins)
    }
    if (!response?.coins || typeof response.coins !== 'object' || Array.isArray(response.coins))
      throw new Error('Malformed earliest-price response')
    for (const coin of coins) {
      const sample = response.coins[coin]
      if (
        sample !== undefined &&
        (!sample ||
          !Number.isSafeInteger(sample.timestamp) ||
          sample.timestamp <= 0 ||
          !Number.isFinite(sample.price) ||
          sample.price <= 0)
      )
        throw new Error('Malformed earliest-price observation')
    }
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(response), { flag: 'wx' })
    for (const coin of coins) {
      const sample = response.coins[coin]
      firstByCoin.set(coin, sample?.timestamp ?? null)
      if (sample) {
        const day = Math.floor(sample.timestamp / DAY) * DAY + DAY - 1
        const candidates = [day - DAY, day].filter((day) => day >= start && day <= end)
        matchedByCoin.set(coin, matchPricesToRequests(candidates, [sample]))
      }
    }
  } catch {
    for (const coin of coins)
      failedByCoin.set(
        coin,
        new Set(Array.from({ length: Math.floor((end - start) / DAY) + 1 }, (_, n) => start + n * DAY))
      )
  }
}
// Earliest-price evidence bounds chart history. Missing/failed first responses
// stay distinct. Group similar start dates to avoid requesting empty years.
const active = identifiers
  .filter((coin) => firstByCoin.get(coin) != null && firstByCoin.get(coin)! <= end + DEFI_LLAMA_SEARCH_WIDTH_SECONDS)
  .sort((a, b) => firstByCoin.get(a)! - firstByCoin.get(b)!)
for (let offset = 0; offset < active.length; offset += 5) {
  const coins = active.slice(offset, offset + 5)
  const first = Math.min(...coins.map((coin) => firstByCoin.get(coin)!))
  const firstDay = Math.floor((first - DEFI_LLAMA_SEARCH_WIDTH_SECONDS) / DAY) * DAY + DAY - 1
  // Provider rejects coins * span > 500. Keep our existing 365-day cap too.
  const span = Math.min(365, Math.floor(500 / coins.length))
  for (let from = Math.max(start, firstDay); from <= end; from += span * DAY) {
    const days = Array.from({ length: Math.min(span, Math.floor((end - from) / DAY) + 1) }, (_, n) => from + n * DAY)
    const cacheKey = createHash('sha256')
      .update(JSON.stringify({ coins, from, days: days.length, window: DEFI_LLAMA_SEARCH_WIDTH }))
      .digest('hex')
    const file = resolve(out, 'chart-' + cacheKey + '.json')
    let response: { coins?: Record<string, { symbol?: string; prices?: DefiLlamaSample[] }> }
    try {
      if (existsSync(file)) response = JSON.parse(readFileSync(file, 'utf8'))
      else {
        requests++
        response = await provider.getChart(coins, {
          start: from,
          span: days.length,
          period: '1d',
          searchWidth: DEFI_LLAMA_SEARCH_WIDTH
        })
      }
      validateCoverageChart(response, [])
      let allValid = true
      for (const coin of coins) {
        try {
          validateCoverageChart(response, [coin])
        } catch {
          allValid = false
          const invalid = invalidByCoin.get(coin) ?? new Set<number>()
          for (const day of days) invalid.add(day)
          invalidByCoin.set(coin, invalid)
          appendFileSync(
            resolve(out, 'invalid-observations.jsonl'),
            JSON.stringify({
              coin,
              from,
              days: days.length,
              status: 'invalid',
              reason: 'Non-positive, malformed or conflicting provider observations'
            }) + '\n'
          )
          continue
        }

        const samples = response.coins?.[coin]?.prices ?? []
        const prices = matchedByCoin.get(coin) ?? new Map()
        for (const [day, sample] of matchPricesToRequests(days, samples)) prices.set(day, sample)
        matchedByCoin.set(coin, prices)
        for (const item of state.values())
          if (coin.endsWith(':' + item.asset.token.toLowerCase()) && response.coins?.[coin]?.symbol)
            item.symbol = response.coins[coin].symbol
      }
      if (allValid && !existsSync(file)) writeFileSync(file, JSON.stringify(response), { flag: 'wx' })
    } catch {
      for (const coin of coins) {
        const failed = failedByCoin.get(coin) ?? new Set()
        for (const day of days) failed.add(day)
        failedByCoin.set(coin, failed)
      }
      appendFileSync(
        resolve(out, 'failures.jsonl'),
        JSON.stringify({ coins, from, days: days.length, status: 'retryable' }) + '\n'
      )
    }
    console.log(JSON.stringify({ stage: 'coverage-chart', group: offset / 5, from: dateOf(from), requests, retries }))
  }
}
const graphDays = new Map<string, number[]>()
if (values.graph) {
  const graph = JSON.parse(readFileSync(values.graph, 'utf8')) as { nodes: GraphNode[] }
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  for (const node of graph.nodes) {
    if (!node.path || node.target.timestamp == null) continue
    const token = node.target.token.toLowerCase()
    try {
      validateGraphResolution(
        node,
        {
          chainId: node.target.chainId,
          chain: chainIdToName(node.target.chainId)!,
          token: node.target.token as `0x${string}`,
          tokenLowercase: token,
          eodTimestamp: node.target.timestamp
        },
        nodes
      )
      const key = node.target.chainId + ':' + token
      graphDays.set(key, [...(graphDays.get(key) ?? []), node.target.timestamp])
    } catch {
      /* Rejected graph candidates do not establish coverage. */
    }
  }
}
const results = [...state.values()].map((item) => {
  const chain = chainIdToName(item.asset.chainId)!
  const direct = chain + ':' + item.asset.token.toLowerCase()
  item.provider = [...(matchedByCoin.get(direct)?.keys() ?? [])]
  item.failed = [...(failedByCoin.get(direct) ?? [])]
  const alias = getDefiLlamaCoinGeckoAlias(chain, item.asset.token)
  if (alias) {
    for (const [day, sample] of matchedByCoin.get(alias.identifier) ?? []) {
      if (isDefiLlamaAliasValidAt(alias, day) && isDefiLlamaAliasValidAt(alias, sample.timestamp)) item.alias.push(day)
    }
    item.failed.push(
      ...[...(failedByCoin.get(alias.identifier) ?? [])].filter((day) => isDefiLlamaAliasValidAt(alias, day))
    )
  }
  const missing = item.asset.observations
    .filter(needsOwnPricing)
    .map((entry) => Date.parse(entry.date) / 1000 + DAY - 1)
  const reconstructed = graphDays.get(item.asset.chainId + ':' + item.asset.token.toLowerCase()) ?? []
  const covered = [...new Set([...item.stored, ...item.provider, ...item.alias, ...reconstructed])].sort(
    (a, b) => a - b
  )
  const coveredSet = new Set(covered)
  const invalid = [
    ...new Set([...(invalidByCoin.get(direct) ?? []), ...(alias ? (invalidByCoin.get(alias.identifier) ?? []) : [])])
  ].filter((day) => !coveredSet.has(day))
  const unknown = [...new Set(item.failed)].filter((day) => !coveredSet.has(day))
  return {
    chainId: item.asset.chainId,
    token: item.asset.token,
    symbol: item.asset.symbol ?? item.symbol ?? null,
    requestedGaps: classifyCoverage(missing, covered, unknown.length + invalid.length > 0),
    storedEod: classifyCoverage(missing, item.stored),
    storedAnyTime: item.storedAny,
    provider: classifyCoverage(missing, [...item.provider, ...item.alias], unknown.length + invalid.length > 0),
    earliestProviderObservation: firstByCoin.get(direct) ?? null,
    earliestProviderLookup: firstByCoin.has(direct) ? 'complete' : 'retryable',
    graphCandidateDays: [...new Set(reconstructed)].length,
    providerDays: item.provider.length,
    aliasDays: item.alias.length,
    retryableRanges: ranges(unknown),
    invalidObservationRanges: ranges(invalid),
    usableRanges: ranges(covered),
    deployment: 'Not inferred from first price; predeployment status unverified',
    adapterLifetimeCoverage: 'Not exhaustively scanned; graph evidence covers requested dates only'
  }
})
writeFileSync(
  resolve(out, 'coverage.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      start: dateOf(start),
      end: dateOf(end),
      matchingWindow: DEFI_LLAMA_SEARCH_WIDTH,
      requests,
      retries,
      assets: results,
      scope:
        'Daily DeFiLlama direct/eligible alias observations and all stored history through cutoff; no new adapter implementation or DB writes'
    },
    null,
    2
  )
)
console.log(JSON.stringify({ stage: 'coverage-complete', assets: results.length, requests, retries }))
