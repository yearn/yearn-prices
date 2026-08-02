import type { Pool } from '@neondatabase/serverless'
import { normalizeTokenAddress, SUPPORTED_CHAIN_NAMES } from '../chains'
import {
  enqueueDailyPriceTargets,
  getDailyPriceTargets,
  type DailyPriceTargetInput,
} from '../daily-prices'
import { selectEodPriceEvidence } from '../evidence'
import { ApiError, ensure } from '../errors'
import { jsonResponse } from '../http'
import { getBatchHistoricalPriceEvidenceCandidates } from '../queries'
import { latestClosedUtcDayEnd, normalizeToEndOfDay } from '../time'
import type { PriceEvidenceCandidate } from '../types'
import { parseExactEodTimestampSegment, parseOptionalSource } from '../validation'

const MAX_ENQUEUE_TARGETS = 500
const MAX_ENQUEUE_BODY_BYTES = 128 * 1024

interface DailyAssetInput {
  chain: string
  token: string
}

export interface DailyEnqueuePayload {
  day?: string | number
  targets: DailyAssetInput[]
}

export interface ParsedDailyEnqueue {
  eodTimestamp: number
  targets: DailyPriceTargetInput[]
}

function parseDay(value: unknown, nowTimestamp: number): number {
  if (value == null) return latestClosedUtcDayEnd(nowTimestamp)
  let timestamp: number
  if (typeof value === 'number') {
    ensure(Number.isSafeInteger(value) && value >= 0, 'INVALID_INPUT', 'day must be a date or unix timestamp')
    timestamp = normalizeToEndOfDay(value)
  } else {
    ensure(
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
      'INVALID_INPUT',
      'day must use YYYY-MM-DD',
    )
    const parsedDate = new Date(`${value}T23:59:59.000Z`)
    ensure(
      !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === value,
      'INVALID_INPUT',
      'day is not a valid UTC calendar date',
    )
    timestamp = Math.floor(parsedDate.getTime() / 1_000)
  }
  ensure(timestamp <= latestClosedUtcDayEnd(nowTimestamp), 'INVALID_INPUT', 'day must be a closed UTC day')
  return timestamp
}

export function parseDailyEnqueuePayload(
  value: unknown,
  nowTimestamp = Math.floor(Date.now() / 1_000),
): ParsedDailyEnqueue {
  ensure(value != null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'Body must be an object')
  const payload = value as Partial<DailyEnqueuePayload>
  ensure(Array.isArray(payload.targets), 'INVALID_INPUT', 'targets must be an array')
  ensure(payload.targets.length > 0, 'INVALID_INPUT', 'targets must not be empty')
  ensure(
    payload.targets.length <= MAX_ENQUEUE_TARGETS,
    'INVALID_INPUT',
    `A maximum of ${MAX_ENQUEUE_TARGETS} targets is allowed`,
  )
  const eodTimestamp = parseDay(payload.day, nowTimestamp)
  const unique = new Map<string, DailyPriceTargetInput>()
  for (const raw of payload.targets) {
    ensure(raw != null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_INPUT', 'Each target must be an object')
    ensure(typeof raw.chain === 'string', 'INVALID_INPUT', 'Each target requires a chain')
    ensure(typeof raw.token === 'string', 'INVALID_INPUT', 'Each target requires a token')
    const chain = raw.chain.toLowerCase()
    ensure(SUPPORTED_CHAIN_NAMES.has(chain), 'INVALID_INPUT', `Unsupported chain: ${raw.chain}`)
    let token: string
    try {
      token = normalizeTokenAddress(raw.token)
    } catch (error) {
      throw new ApiError('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid token address')
    }
    unique.set(`${chain}:${token}`, {
      chain,
      token,
      eodTimestamp,
      metadata: { origin: 'daily-enqueue-api' },
    })
  }
  return { eodTimestamp, targets: [...unique.values()] }
}

function targetKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

function groupCandidates(candidates: PriceEvidenceCandidate[]): Map<string, PriceEvidenceCandidate[]> {
  const grouped = new Map<string, PriceEvidenceCandidate[]>()
  for (const candidate of candidates) {
    const key = targetKey(candidate.chain, candidate.token)
    const current = grouped.get(key) ?? []
    current.push(candidate)
    grouped.set(key, current)
  }
  return grouped
}

export interface DailyEnqueueDependencies {
  loadCandidates?: typeof getBatchHistoricalPriceEvidenceCandidates
  enqueue?: typeof enqueueDailyPriceTargets
  loadTargets?: typeof getDailyPriceTargets
}

export async function handleDailyEnqueue(
  request: Request,
  pool: Pool,
  dependencies: DailyEnqueueDependencies = {},
): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  ensure(
    Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= MAX_ENQUEUE_BODY_BYTES,
    'INVALID_INPUT',
    `Request body must not exceed ${MAX_ENQUEUE_BODY_BYTES} bytes`,
  )
  const raw = await request.text()
  ensure(
    new TextEncoder().encode(raw).byteLength <= MAX_ENQUEUE_BODY_BYTES,
    'INVALID_INPUT',
    `Request body must not exceed ${MAX_ENQUEUE_BODY_BYTES} bytes`,
  )
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Body must be valid JSON')
  }

  const parsed = parseDailyEnqueuePayload(body)
  const requests = parsed.targets.map(target => ({
    chain: target.chain,
    token: target.token,
    timestamp: parsed.eodTimestamp,
  }))
  const loadCandidates = dependencies.loadCandidates ?? getBatchHistoricalPriceEvidenceCandidates
  const candidates = await loadCandidates(pool, requests)
  const grouped = groupCandidates(candidates)
  const missing: DailyPriceTargetInput[] = []
  const results = parsed.targets.map(target => {
    const selection = selectEodPriceEvidence(
      parsed.eodTimestamp,
      grouped.get(targetKey(target.chain, target.token)) ?? [],
    )
    if (selection.selected) {
      return {
        chain: target.chain,
        token: target.token,
        eodTimestamp: target.eodTimestamp,
        status: 'priced' as const,
        source: selection.selected.source,
        adapter: selection.selected.adapter,
        quality: selection.selected.quality,
      }
    }
    missing.push(target)
    return {
      chain: target.chain,
      token: target.token,
      eodTimestamp: target.eodTimestamp,
      status: 'missing' as const,
      validation: selection.validation,
    }
  })

  const enqueue = dependencies.enqueue ?? enqueueDailyPriceTargets
  const inserted = await enqueue(pool, missing)
  const loadTargets = dependencies.loadTargets ?? getDailyPriceTargets
  const durable = await loadTargets(pool, missing)
  const durableByKey = new Map(durable.map(target => [targetKey(target.chain, target.token), target]))
  const finalResults = results.map(result => {
    if (result.status === 'priced') return result
    const target = durableByKey.get(targetKey(result.chain, result.token))
    return target
      ? {
          ...result,
          status: target.status,
          attempts: target.attemptCount,
          failureClass: target.failureClass,
          failureReason: target.failureReason,
        }
      : result
  })
  const priced = finalResults.filter(result => result.status === 'priced').length

  return jsonResponse({
    eodTimestamp: parsed.eodTimestamp,
    requested: (body as DailyEnqueuePayload).targets.length,
    deduplicated: parsed.targets.length,
    alreadyPriced: results.filter(result => result.status === 'priced').length,
    inserted,
    existingQueue: missing.length - inserted,
    coverage: {
      priced,
      total: parsed.targets.length,
      complete: priced === parsed.targets.length,
    },
    targets: finalResults,
  }, { status: 202, headers: { 'cache-control': 'no-store' } })
}

export async function handleDailyPriceRead(
  request: Request,
  pool: Pool,
  timestampSegment: string,
  tokenKeySegment: string,
  evidenceOnly = false,
): Promise<Response> {
  const eodTimestamp = parseExactEodTimestampSegment(timestampSegment)
  const separator = tokenKeySegment.indexOf(':')
  ensure(separator > 0, 'INVALID_INPUT', 'Token key must be "<chain>:<address>"')
  const chain = tokenKeySegment.slice(0, separator).toLowerCase()
  ensure(SUPPORTED_CHAIN_NAMES.has(chain), 'INVALID_INPUT', `Unsupported chain: ${chain}`)
  let token: string
  try {
    token = normalizeTokenAddress(tokenKeySegment.slice(separator + 1))
  } catch (error) {
    throw new ApiError('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid token address')
  }
  const source = parseOptionalSource(new URL(request.url).searchParams.get('source'))
  const candidates = await getBatchHistoricalPriceEvidenceCandidates(pool, [{
    chain,
    token,
    timestamp: eodTimestamp,
  }], source)
  const selection = selectEodPriceEvidence(eodTimestamp, candidates)

  if (evidenceOnly) {
    return jsonResponse(selection, { headers: { 'cache-control': 'no-store' } })
  }
  if (!selection.selected) {
    const status = selection.validation.status === 'quarantined' ? 409 : 404
    return jsonResponse({
      error: {
        code: selection.validation.status === 'quarantined' ? 'QUARANTINED' : 'NOT_FOUND',
        message: selection.validation.failureReason,
      },
      validation: selection.validation,
    }, { status, headers: { 'cache-control': 'no-store' } })
  }
  return jsonResponse({
    coin: {
      chain,
      token,
      timestamp: eodTimestamp,
      price: selection.selected.priceUsd,
      symbol: selection.selected.symbol,
      confidence: selection.selected.confidence,
      source: selection.selected.source,
      adapter: selection.selected.adapter,
      classification: selection.selected.classification,
      quality: selection.selected.quality,
    },
  }, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
}
