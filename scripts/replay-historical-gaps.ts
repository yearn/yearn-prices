import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'

loadEnv()

import { readChartCoin } from '../src/backfill/chart-envelope'
import {
  CHART_REQUEST_TIMEOUT_MS,
  CHART_RETRY_AFTER_CAP_MS,
  EXACT_READ_CHUNK_SIZE,
  MAXIMUM_CHART_SPAN_DAYS
} from '../src/backfill/constants'
import { manifestDigest, type NormalizedTarget, parseManifest } from '../src/backfill/manifest'
import { type MatchResult, matchChartObservation } from '../src/backfill/matcher'
import { DefiLlamaClient, SlidingWindowRateLimiter } from '../src/clients'
import { createPool, getBatchHistoricalPrices } from '../src/db'
import {
  getDefiLlamaCoinGeckoAlias,
  isDefiLlamaAliasValidAt,
  listDefiLlamaCoinGeckoAliases
} from '../src/sources/defillama/aliases'
import type { ExactPriceRecord, HistoricalRequestTuple } from '../src/types'

const DAY_SECONDS = 86_400

type Cohort = 'control' | 'gap'
type Method = 'direct' | 'alias'
type CaptureResult = 'resolved' | 'not_found' | 'invalid_response' | 'request_failed'
type Direction = 'before' | 'exact' | 'after'

interface ReplayWindow {
  label: string
  searchWidth: string
  offsetSeconds: number
}

const DEFAULT_WINDOWS: ReplayWindow[] = [
  { label: '1h', searchWidth: '1h', offsetSeconds: 3_600 },
  { label: '2h', searchWidth: '2h', offsetSeconds: 7_200 },
  { label: '6h', searchWidth: '6h', offsetSeconds: 21_600 }
]

interface CaptureRecord {
  cohort: Cohort
  chainId: number
  chain: string
  token: string
  eodTimestamp: number
  window: string
  method: Method
  providerIdentifier: string
  rangeStart: number
  rangeEnd: number
  result: CaptureResult
  observedTimestamp: number | null
  signedOffsetSeconds: number | null
  absoluteOffsetSeconds: number | null
  direction: Direction | null
  price: number | null
  symbol: string | null
  confidence: number | null
  retainedWarmupPrice: number | null
  relativeDifference: number | null
  equalDistanceTie: boolean
  attempts: number
  diagnosticCodes: string[]
}

interface RequestRecord {
  window: string
  method: Method
  providerIdentifier: string
  rangeStart: number
  rangeEnd: number
  requestedPeriods: number
  result: 'ok' | 'invalid_response' | 'request_failed'
  responsePoints: number
  usablePoints: number
  missingDailyPeriods: number[]
  firstPeriodResolved: boolean | null
  lastPeriodResolved: boolean | null
  attempts: number
}

interface Args {
  controlManifestPath: string
  gapManifestPath: string
  reportPath: string
  csvPath: string
  databaseUrl?: string
  windows: ReplayWindow[]
  maximumChartSpanDays: number
}

function parseArgs(argv: string[]): Args {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = argv[index + 1]
    if (current.startsWith('--') && next) {
      options.set(current, next)
      index += 1
    }
  }

  const controlManifestPath = options.get('--control-manifest')
  const gapManifestPath = options.get('--gap-manifest')
  const reportPath = options.get('--report')
  const csvPath = options.get('--csv')
  if (!controlManifestPath || !gapManifestPath || !reportPath || !csvPath) {
    throw new Error('--control-manifest, --gap-manifest, --report, and --csv are required')
  }

  const windowsRaw = options.get('--windows')
  const windows = windowsRaw
    ? windowsRaw.split(',').map((label) => {
        const match = DEFAULT_WINDOWS.find((candidate) => candidate.label === label.trim())
        if (!match) {
          throw new Error(`unsupported --windows value: ${label}`)
        }
        return match
      })
    : DEFAULT_WINDOWS

  const maximumChartSpanDays = options.has('--max-chart-span-days')
    ? Number(options.get('--max-chart-span-days'))
    : MAXIMUM_CHART_SPAN_DAYS
  if (!Number.isInteger(maximumChartSpanDays) || maximumChartSpanDays <= 0) {
    throw new Error('--max-chart-span-days must be a positive integer')
  }

  return {
    controlManifestPath,
    gapManifestPath,
    reportPath,
    csvPath,
    databaseUrl: options.get('--database-url'),
    windows,
    maximumChartSpanDays
  }
}

interface TargetRange {
  identifier: string
  rangeStart: number
  rangeEnd: number
  items: Array<{ cohort: Cohort; target: NormalizedTarget }>
}

export function groupContiguousRanges(
  items: Array<{ cohort: Cohort; target: NormalizedTarget }>,
  identifierOf: (target: NormalizedTarget) => string,
  maximumSpanDays: number
): TargetRange[] {
  const byIdentifier = new Map<string, Array<{ cohort: Cohort; target: NormalizedTarget }>>()
  for (const item of items) {
    const identifier = identifierOf(item.target)
    const group = byIdentifier.get(identifier) ?? []
    group.push(item)
    byIdentifier.set(identifier, group)
  }

  const ranges: TargetRange[] = []
  for (const [identifier, group] of byIdentifier) {
    const sorted = [...group].sort((left, right) => left.target.eodTimestamp - right.target.eodTimestamp)

    let current: TargetRange | null = null
    for (const item of sorted) {
      const eod = item.target.eodTimestamp
      const spanDays = current ? (eod - current.rangeStart) / DAY_SECONDS + 1 : 0

      if (current && eod === current.rangeEnd + DAY_SECONDS && spanDays <= maximumSpanDays) {
        current.rangeEnd = eod
        current.items.push(item)
        continue
      }

      current = { identifier, rangeStart: eod, rangeEnd: eod, items: [item] }
      ranges.push(current)
    }
  }

  return ranges
}

export function matchChartResponse(
  response: unknown,
  identifier: string,
  eodTimestamp: number,
  options: { maximumOffsetSeconds: number; isEligibleObservation?: (observedTimestamp: number) => boolean }
): MatchResult {
  const envelope = readChartCoin(response, identifier)
  if (envelope.kind === 'invalid') {
    return { kind: 'invalid_response' }
  }
  return matchChartObservation(envelope.kind === 'coin' ? envelope.coin : undefined, eodTimestamp, options)
}

function observationList(coin: unknown): { total: number; points: Array<{ timestamp: number; price: number }> } {
  if (coin == null || typeof coin !== 'object' || Array.isArray(coin)) {
    return { total: 0, points: [] }
  }
  const prices = (coin as Record<string, unknown>).prices
  if (!Array.isArray(prices)) {
    return { total: 0, points: [] }
  }

  const points: Array<{ timestamp: number; price: number }> = []
  for (const raw of prices) {
    if (raw == null || typeof raw !== 'object') {
      continue
    }
    const { timestamp, price } = raw as Record<string, unknown>
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      continue
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      continue
    }
    points.push({ timestamp, price })
  }

  return { total: prices.length, points }
}

export interface RangeCoverage {
  responsePoints: number
  usablePoints: number
  missingDailyPeriods: number[]
  firstPeriodResolved: boolean
  lastPeriodResolved: boolean
}

export function summarizeRangeResponse(
  coin: unknown,
  options: {
    rangeStart: number
    rangeEnd: number
    offsetSeconds: number
    isEligibleObservation?: (observedTimestamp: number) => boolean
  }
): RangeCoverage {
  const { total, points } = observationList(coin)
  const eligible = points.filter(
    (point) => !options.isEligibleObservation || options.isEligibleObservation(point.timestamp)
  )

  const periods: number[] = []
  for (let period = options.rangeStart; period <= options.rangeEnd; period += DAY_SECONDS) {
    periods.push(period)
  }

  const covers = (period: number, timestamp: number) => Math.abs(timestamp - period) <= options.offsetSeconds
  const missingDailyPeriods = periods.filter((period) => !eligible.some((point) => covers(period, point.timestamp)))
  const usablePoints = eligible.filter((point) => periods.some((period) => covers(period, point.timestamp))).length

  return {
    responsePoints: total,
    usablePoints,
    missingDailyPeriods,
    firstPeriodResolved: !missingDailyPeriods.includes(periods[0]),
    lastPeriodResolved: !missingDailyPeriods.includes(periods[periods.length - 1])
  }
}

export function hasEqualDistanceTie(
  coin: unknown,
  eodTimestamp: number,
  options: { offsetSeconds: number; isEligibleObservation?: (observedTimestamp: number) => boolean }
): boolean {
  const { points } = observationList(coin)
  const candidates = new Set<number>()
  for (const point of points) {
    if (Math.abs(point.timestamp - eodTimestamp) > options.offsetSeconds) {
      continue
    }
    if (options.isEligibleObservation && !options.isEligibleObservation(point.timestamp)) {
      continue
    }
    candidates.add(point.timestamp)
  }

  let bestDistance = Number.POSITIVE_INFINITY
  let bestCount = 0
  for (const timestamp of candidates) {
    const distance = Math.abs(timestamp - eodTimestamp)
    if (distance < bestDistance) {
      bestDistance = distance
      bestCount = 1
      continue
    }
    if (distance === bestDistance) {
      bestCount += 1
    }
  }

  return bestCount > 1
}

export function classifyDirection(signedOffsetSeconds: number): Direction {
  if (signedOffsetSeconds === 0) {
    return 'exact'
  }
  return signedOffsetSeconds < 0 ? 'before' : 'after'
}

export function percentile(sortedValues: number[], fraction: number): number | null {
  if (sortedValues.length === 0) {
    return null
  }
  const index = Math.min(sortedValues.length - 1, Math.ceil(fraction * sortedValues.length) - 1)
  return sortedValues[Math.max(0, index)]
}

function distributionSummary(values: number[]): {
  count: number
  min: number | null
  median: number | null
  p90: number | null
  max: number | null
} {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted.length > 0 ? sorted[0] : null,
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null
  }
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

const CSV_COLUMNS: Array<keyof CaptureRecord> = [
  'cohort',
  'chainId',
  'chain',
  'token',
  'eodTimestamp',
  'window',
  'method',
  'providerIdentifier',
  'rangeStart',
  'rangeEnd',
  'result',
  'observedTimestamp',
  'signedOffsetSeconds',
  'absoluteOffsetSeconds',
  'direction',
  'price',
  'symbol',
  'confidence',
  'retainedWarmupPrice',
  'relativeDifference',
  'equalDistanceTie',
  'attempts',
  'diagnosticCodes'
]

function toCsv(records: CaptureRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const record of records) {
    const row = CSV_COLUMNS.map((column) => {
      const value = record[column]
      if (value === null || value === undefined) {
        return ''
      }
      if (Array.isArray(value)) {
        return csvEscape(value.join('|'))
      }
      return csvEscape(String(value))
    })
    lines.push(row.join(','))
  }
  return `${lines.join('\n')}\n`
}

function toolVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url))
    return (JSON.parse(raw.toString('utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function gitRevision(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: import.meta.dirname })
      .toString()
      .trim()
  } catch {
    return null
  }
}

async function run(args: Args): Promise<void> {
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'a database URL is required: pass --database-url or set DATABASE_URL (read-only credentials preferred)'
    )
  }

  const controlBytes = readFileSync(args.controlManifestPath)
  const gapBytes = readFileSync(args.gapManifestPath)
  const controlManifest = parseManifest(controlBytes)
  const gapManifest = parseManifest(gapBytes)

  const pool = createPool(databaseUrl)
  const stats = { apiCalls: 0, retries: 0, requestFailures: 0 }
  const rateLimiter = new SlidingWindowRateLimiter(10, 1000)

  try {
    const allTargets: Array<{ cohort: Cohort; target: NormalizedTarget }> = [
      ...controlManifest.targets.map((target) => ({ cohort: 'control' as const, target })),
      ...gapManifest.targets.map((target) => ({ cohort: 'gap' as const, target }))
    ]

    const requests: HistoricalRequestTuple[] = allTargets.map(({ target }) => ({
      chain: target.chain,
      token: target.token,
      timestamp: target.eodTimestamp
    }))

    const existingByKey = new Map<string, ExactPriceRecord>()
    for (let offset = 0; offset < requests.length; offset += EXACT_READ_CHUNK_SIZE) {
      const chunkRequests = requests.slice(offset, offset + EXACT_READ_CHUNK_SIZE)
      const rows = await getBatchHistoricalPrices(pool, chunkRequests)
      for (const row of rows) {
        existingByKey.set(`${row.chain}:${row.token}:${row.timestamp}`, row)
      }
    }

    const gapTargetsNowPopulated: NormalizedTarget[] = []
    const activeTargets = allTargets.filter(({ cohort, target }) => {
      if (cohort !== 'gap') {
        return true
      }
      const key = `${target.chain}:${target.token}:${target.eodTimestamp}`
      if (existingByKey.has(key)) {
        gapTargetsNowPopulated.push(target)
        return false
      }
      return true
    })

    const captureRecords: CaptureRecord[] = []
    const requestRecords: RequestRecord[] = []

    for (const window of args.windows) {
      const directRanges = groupContiguousRanges(
        activeTargets,
        (target) => `${target.chain}:${target.tokenLowercase}`,
        args.maximumChartSpanDays
      )

      const directResultByKey = new Map<string, ReturnType<typeof matchChartObservation>>()

      for (const range of directRanges) {
        let retries = 0
        const client = chartClient(rateLimiter, () => {
          retries += 1
          stats.retries += 1
        })

        stats.apiCalls += 1
        try {
          const spanDays = (range.rangeEnd - range.rangeStart) / DAY_SECONDS + 1
          const response = await client.getChart([range.identifier], {
            start: range.rangeStart,
            span: spanDays,
            period: '1d',
            searchWidth: window.searchWidth
          })
          const envelope = readChartCoin(response, range.identifier)
          const coin = envelope.kind === 'coin' ? envelope.coin : undefined

          requestRecords.push(
            buildRequestRecord(window, 'direct', range, envelope.kind === 'invalid', coin, 1 + retries, {})
          )

          for (const { cohort, target } of range.items) {
            const matched = matchChartResponse(response, range.identifier, target.eodTimestamp, {
              maximumOffsetSeconds: window.offsetSeconds
            })
            const key = `${target.chain}:${target.token}:${target.eodTimestamp}`
            directResultByKey.set(key, matched)
            const record = buildCaptureRecord(
              cohort,
              target,
              window.label,
              'direct',
              range.identifier,
              range,
              matched,
              existingByKey,
              1 + retries
            )
            record.equalDistanceTie = hasEqualDistanceTie(coin, target.eodTimestamp, {
              offsetSeconds: window.offsetSeconds
            })
            captureRecords.push(record)
          }
        } catch {
          stats.requestFailures += 1
          requestRecords.push(buildFailedRequestRecord(window, 'direct', range, 1 + retries))
          for (const { cohort, target } of range.items) {
            const key = `${target.chain}:${target.token}:${target.eodTimestamp}`
            directResultByKey.set(key, { kind: 'not_found' })
            captureRecords.push(
              buildFailedCaptureRecord(cohort, target, window.label, 'direct', range.identifier, range, 1 + retries)
            )
          }
        }
      }

      const aliasCandidates = activeTargets.filter(({ target }) => {
        const key = `${target.chain}:${target.token}:${target.eodTimestamp}`
        const directResult = directResultByKey.get(key)
        if (!directResult || directResult.kind === 'matched') {
          return false
        }
        const alias = getDefiLlamaCoinGeckoAlias(target.chain, target.token)
        return alias != null && isDefiLlamaAliasValidAt(alias, target.eodTimestamp)
      })

      const aliasRanges = groupContiguousRanges(
        aliasCandidates,
        (target) => getDefiLlamaCoinGeckoAlias(target.chain, target.token)!.identifier,
        args.maximumChartSpanDays
      )

      for (const range of aliasRanges) {
        let retries = 0
        const client = chartClient(rateLimiter, () => {
          retries += 1
          stats.retries += 1
        })

        stats.apiCalls += 1
        try {
          const spanDays = (range.rangeEnd - range.rangeStart) / DAY_SECONDS + 1
          const response = await client.getChart([range.identifier], {
            start: range.rangeStart,
            span: spanDays,
            period: '1d',
            searchWidth: window.searchWidth
          })
          const envelope = readChartCoin(response, range.identifier)
          const coin = envelope.kind === 'coin' ? envelope.coin : undefined

          requestRecords.push(
            buildRequestRecord(window, 'alias', range, envelope.kind === 'invalid', coin, 1 + retries, {})
          )

          for (const { cohort, target } of range.items) {
            const alias = getDefiLlamaCoinGeckoAlias(target.chain, target.token)!
            const isEligibleObservation = (observedTimestamp: number) =>
              isDefiLlamaAliasValidAt(alias, observedTimestamp)
            const matched = matchChartResponse(response, range.identifier, target.eodTimestamp, {
              maximumOffsetSeconds: window.offsetSeconds,
              isEligibleObservation
            })
            const record = buildCaptureRecord(
              cohort,
              target,
              window.label,
              'alias',
              range.identifier,
              range,
              matched,
              existingByKey,
              1 + retries
            )
            record.equalDistanceTie = hasEqualDistanceTie(coin, target.eodTimestamp, {
              offsetSeconds: window.offsetSeconds,
              isEligibleObservation
            })
            captureRecords.push(record)
          }
        } catch {
          stats.requestFailures += 1
          requestRecords.push(buildFailedRequestRecord(window, 'alias', range, 1 + retries))
          for (const { cohort, target } of range.items) {
            captureRecords.push(
              buildFailedCaptureRecord(cohort, target, window.label, 'alias', range.identifier, range, 1 + retries)
            )
          }
        }
      }
    }

    const report = buildReport({
      controlManifestPath: args.controlManifestPath,
      gapManifestPath: args.gapManifestPath,
      controlManifest,
      gapManifest,
      windows: args.windows,
      captureRecords,
      requestRecords,
      gapTargetsNowPopulated,
      stats
    })

    writeFileSync(args.reportPath, JSON.stringify(report, null, 2))
    writeFileSync(args.csvPath, toCsv(captureRecords))
    console.info(JSON.stringify({ message: 'replay-complete', report: args.reportPath, csv: args.csvPath, ...stats }))
  } finally {
    await pool.end()
  }
}

function chartClient(rateLimiter: SlidingWindowRateLimiter, onRetry: () => void): DefiLlamaClient {
  return new DefiLlamaClient(rateLimiter, onRetry, {
    timeoutMs: CHART_REQUEST_TIMEOUT_MS,
    honorRetryAfter: true,
    retryAfterCapMs: CHART_RETRY_AFTER_CAP_MS,
    retryTransportErrors: true
  })
}

function requestedPeriods(range: TargetRange): number {
  return (range.rangeEnd - range.rangeStart) / DAY_SECONDS + 1
}

function buildRequestRecord(
  window: ReplayWindow,
  method: Method,
  range: TargetRange,
  malformed: boolean,
  coin: unknown,
  attempts: number,
  options: { isEligibleObservation?: (observedTimestamp: number) => boolean }
): RequestRecord {
  const base = {
    window: window.label,
    method,
    providerIdentifier: range.identifier,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    requestedPeriods: requestedPeriods(range),
    attempts
  }

  if (malformed) {
    return {
      ...base,
      result: 'invalid_response',
      responsePoints: 0,
      usablePoints: 0,
      missingDailyPeriods: [],
      firstPeriodResolved: null,
      lastPeriodResolved: null
    }
  }

  const coverage = summarizeRangeResponse(coin, {
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    offsetSeconds: window.offsetSeconds,
    isEligibleObservation: options.isEligibleObservation
  })

  return { ...base, result: 'ok', ...coverage }
}

function buildFailedRequestRecord(
  window: ReplayWindow,
  method: Method,
  range: TargetRange,
  attempts: number
): RequestRecord {
  return {
    window: window.label,
    method,
    providerIdentifier: range.identifier,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    requestedPeriods: requestedPeriods(range),
    result: 'request_failed',
    responsePoints: 0,
    usablePoints: 0,
    missingDailyPeriods: [],
    firstPeriodResolved: null,
    lastPeriodResolved: null,
    attempts
  }
}

function buildCaptureRecord(
  cohort: Cohort,
  target: NormalizedTarget,
  window: string,
  method: Method,
  providerIdentifier: string,
  range: TargetRange,
  matched: ReturnType<typeof matchChartObservation>,
  existingByKey: Map<string, ExactPriceRecord>,
  attempts: number
): CaptureRecord {
  const retainedWarmupPrice =
    cohort === 'control'
      ? (existingByKey.get(`${target.chain}:${target.token}:${target.eodTimestamp}`)?.price ?? null)
      : null

  const base: CaptureRecord = {
    cohort,
    chainId: target.chainId,
    chain: target.chain,
    token: target.token,
    eodTimestamp: target.eodTimestamp,
    window,
    method,
    providerIdentifier,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    result: 'not_found',
    observedTimestamp: null,
    signedOffsetSeconds: null,
    absoluteOffsetSeconds: null,
    direction: null,
    price: null,
    symbol: null,
    confidence: null,
    retainedWarmupPrice,
    relativeDifference: null,
    equalDistanceTie: false,
    attempts,
    diagnosticCodes: []
  }

  if (matched.kind === 'invalid_response') {
    base.result = 'invalid_response'
    return base
  }
  if (matched.kind === 'not_found') {
    base.result = 'not_found'
    return base
  }

  base.result = 'resolved'
  base.observedTimestamp = matched.observedTimestamp
  base.signedOffsetSeconds = matched.offsetSeconds
  base.absoluteOffsetSeconds = Math.abs(matched.offsetSeconds)
  base.direction = classifyDirection(matched.offsetSeconds)
  base.price = matched.price
  base.symbol = matched.symbol
  base.confidence = matched.confidence
  if (retainedWarmupPrice != null && retainedWarmupPrice !== 0) {
    base.relativeDifference = (matched.price - retainedWarmupPrice) / retainedWarmupPrice
  }
  return base
}

function buildFailedCaptureRecord(
  cohort: Cohort,
  target: NormalizedTarget,
  window: string,
  method: Method,
  providerIdentifier: string,
  range: TargetRange,
  attempts: number
): CaptureRecord {
  return {
    cohort,
    chainId: target.chainId,
    chain: target.chain,
    token: target.token,
    eodTimestamp: target.eodTimestamp,
    window,
    method,
    providerIdentifier,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    result: 'request_failed',
    observedTimestamp: null,
    signedOffsetSeconds: null,
    absoluteOffsetSeconds: null,
    direction: null,
    price: null,
    symbol: null,
    confidence: null,
    retainedWarmupPrice: null,
    relativeDifference: null,
    equalDistanceTie: false,
    attempts,
    diagnosticCodes: ['retry_exhausted']
  }
}

interface ReportInput {
  controlManifestPath: string
  gapManifestPath: string
  controlManifest: ReturnType<typeof parseManifest>
  gapManifest: ReturnType<typeof parseManifest>
  windows: ReplayWindow[]
  captureRecords: CaptureRecord[]
  requestRecords: RequestRecord[]
  gapTargetsNowPopulated: NormalizedTarget[]
  stats: { apiCalls: number; retries: number; requestFailures: number }
}

function targetKey(record: CaptureRecord): string {
  return `${record.chainId}:${record.token}:${record.eodTimestamp}`
}

function incrementalCoverage(windows: ReplayWindow[], records: CaptureRecord[]) {
  const seen = new Set<string>()
  return windows.map((window) => {
    const resolved = new Set(
      records
        .filter((record) => record.window === window.label && record.result === 'resolved')
        .map((record) => targetKey(record))
    )
    const newlyResolved = [...resolved].filter((key) => !seen.has(key))
    for (const key of resolved) {
      seen.add(key)
    }
    return {
      window: window.label,
      resolvedTargets: resolved.size,
      newlyResolvedTargets: newlyResolved.length,
      newlyResolved
    }
  })
}

export function buildReport(input: ReportInput) {
  const byWindow = input.windows.map((window) => {
    const windowRecords = input.captureRecords.filter((record) => record.window === window.label)
    return {
      window: window.label,
      searchWidth: window.searchWidth,
      maximumAcceptedOffsetSeconds: window.offsetSeconds,
      control: cohortSummary(windowRecords, 'control'),
      gap: cohortSummary(windowRecords, 'gap')
    }
  })

  return {
    toolVersion: toolVersion(),
    codeRevision: gitRevision(),
    mode: 'read-only-replay',
    startedAt: new Date().toISOString(),
    manifest: {
      control: {
        path: input.controlManifestPath,
        digest: input.controlManifest.digest,
        targetCount: input.controlManifest.targets.length
      },
      gap: {
        path: input.gapManifestPath,
        digest: input.gapManifest.digest,
        targetCount: input.gapManifest.targets.length
      }
    },
    aliasRegistryDigest: manifestDigest(JSON.stringify(listDefiLlamaCoinGeckoAliases())),
    windows: input.windows.map((window) => window.label),
    request: input.stats,
    gapTargetsNowPopulated: input.gapTargetsNowPopulated.map((target) => ({
      chainId: target.chainId,
      token: target.token,
      eodTimestamp: target.eodTimestamp
    })),
    byWindow,
    incrementalCoverage: incrementalCoverage(input.windows, input.captureRecords),
    recordCount: input.captureRecords.length,
    requestCount: input.requestRecords.length,
    requests: input.requestRecords,
    records: input.captureRecords
  }
}

function cohortSummary(records: CaptureRecord[], cohort: Cohort) {
  const cohortRecords = records.filter((record) => record.cohort === cohort)
  const directRecords = cohortRecords.filter((record) => record.method === 'direct')
  const aliasRecords = cohortRecords.filter((record) => record.method === 'alias')
  const resolved = cohortRecords.filter((record) => record.result === 'resolved')

  const offsets = resolved.map((record) => record.signedOffsetSeconds as number)
  const absoluteOffsets = offsets.map((value) => Math.abs(value))
  const before = resolved.filter((record) => record.direction === 'before').length
  const exact = resolved.filter((record) => record.direction === 'exact').length
  const after = resolved.filter((record) => record.direction === 'after').length

  const relativeDifferences = resolved
    .map((record) => record.relativeDifference)
    .filter((value): value is number => value != null)

  return {
    targets: new Set(cohortRecords.map((record) => `${record.chainId}:${record.token}:${record.eodTimestamp}`)).size,
    directResolved: directRecords.filter((record) => record.result === 'resolved').length,
    directUnresolved: directRecords.filter((record) => record.result !== 'resolved').length,
    aliasResolved: aliasRecords.filter((record) => record.result === 'resolved').length,
    aliasUnresolved: aliasRecords.filter((record) => record.result !== 'resolved').length,
    notFound: cohortRecords.filter((record) => record.result === 'not_found').length,
    invalidResponse: cohortRecords.filter((record) => record.result === 'invalid_response').length,
    requestFailed: cohortRecords.filter((record) => record.result === 'request_failed').length,
    signedOffsetSeconds: distributionSummary(offsets),
    absoluteOffsetSeconds: distributionSummary(absoluteOffsets),
    direction: { before, exact, after },
    warmupRelativeDifference: distributionSummary(relativeDifferences)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run(parseArgs(process.argv.slice(2)))
}
