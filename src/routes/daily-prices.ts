import type { Pool } from '@neondatabase/serverless'
import { normalizeTokenAddress, SUPPORTED_CHAIN_NAMES } from '../chains'
import {
  enqueueDailyPriceTargets,
  getDailyPriceTargets,
  requeueDailyPriceTargets,
  type DailyPriceFailureClass,
  type DailyPriceRequeueRequest,
  type DailyPriceTargetInput,
} from '../daily-prices'
import { sanitizeFailureReason } from '../daily-price-progress'
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

interface DailyRequeueTargetInput extends DailyAssetInput {
  day: string | number
}

export interface DailyRequeuePayload {
  reason: string
  targets?: DailyRequeueTargetInput[]
  filter?: {
    chain: string
    day: string | number
    statuses?: Array<'unsupported' | 'quarantined'>
    failureClass?: DailyPriceFailureClass
    adapter?: string
    adapterVersion?: string
    policyVersion?: string
  }
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

export function parseDailyRequeuePayload(
  value: unknown,
  requestedBy: string,
  nowTimestamp = Math.floor(Date.now() / 1_000),
): DailyPriceRequeueRequest {
  ensure(value != null && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', 'Body must be an object')
  const payload = value as Partial<DailyRequeuePayload>
  ensure(typeof payload.reason === 'string' && payload.reason.trim().length > 0, 'INVALID_INPUT', 'reason is required')
  ensure(payload.reason.trim().length <= 500, 'INVALID_INPUT', 'reason must not exceed 500 characters')
  const hasTargets = Array.isArray(payload.targets)
  const hasFilter = payload.filter != null && typeof payload.filter === 'object' && !Array.isArray(payload.filter)
  ensure(hasTargets !== hasFilter, 'INVALID_INPUT', 'Provide exactly one targets or filter scope')

  if (hasTargets) {
    ensure(payload.targets!.length > 0, 'INVALID_INPUT', 'targets must not be empty')
    ensure(payload.targets!.length <= MAX_ENQUEUE_TARGETS, 'INVALID_INPUT', `A maximum of ${MAX_ENQUEUE_TARGETS} targets is allowed`)
    const targets = payload.targets!.map(raw => {
      ensure(raw != null && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_INPUT', 'Each target must be an object')
      ensure(typeof raw.chain === 'string' && typeof raw.token === 'string', 'INVALID_INPUT', 'Each target requires chain and token')
      return {
        chain: raw.chain,
        token: raw.token,
        eodTimestamp: parseDay(raw.day, nowTimestamp),
      }
    })
    return { requestedBy, reason: payload.reason.trim(), scope: { targets }, nowTimestamp }
  }

  const filter = payload.filter!
  ensure(typeof filter.chain === 'string', 'INVALID_INPUT', 'filter.chain is required')
  ensure(SUPPORTED_CHAIN_NAMES.has(filter.chain.toLowerCase()), 'INVALID_INPUT', `Unsupported chain: ${filter.chain}`)
  ensure(
    filter.statuses == null || (Array.isArray(filter.statuses)
      && filter.statuses.length > 0
      && filter.statuses.every(status => status === 'unsupported' || status === 'quarantined')),
    'INVALID_INPUT',
    'filter.statuses must contain unsupported or quarantined',
  )
  ensure(
    filter.failureClass == null
      || ['unsupported', 'retryable', 'invalid', 'disagreement'].includes(filter.failureClass),
    'INVALID_INPUT',
    'filter.failureClass is invalid',
  )
  for (const [name, field] of [
    ['adapter', filter.adapter],
    ['adapterVersion', filter.adapterVersion],
    ['policyVersion', filter.policyVersion],
  ] as const) {
    ensure(field == null || (typeof field === 'string' && field.trim().length > 0 && field.length <= 100), 'INVALID_INPUT', `filter.${name} is invalid`)
  }
  return {
    requestedBy,
    reason: payload.reason.trim(),
    scope: {
      filter: {
        chain: filter.chain,
        eodTimestamp: parseDay(filter.day, nowTimestamp),
        statuses: filter.statuses,
        failureClass: filter.failureClass,
        adapter: filter.adapter?.trim(),
        adapterVersion: filter.adapterVersion?.trim(),
        policyVersion: filter.policyVersion?.trim(),
      },
    },
    nowTimestamp,
  }
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
      validation: {
        ...selection.validation,
        failureReason: sanitizeFailureReason(selection.validation.failureReason),
      },
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
          failureReason: sanitizeFailureReason(target.failureReason),
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

export interface DailyRequeueDependencies {
  requeue?: typeof requeueDailyPriceTargets
}

export async function handleDailyRequeue(
  request: Request,
  pool: Pool,
  requestedBy: string,
  dependencies: DailyRequeueDependencies = {},
): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  ensure(
    Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= MAX_ENQUEUE_BODY_BYTES,
    'INVALID_INPUT',
    `Request body must not exceed ${MAX_ENQUEUE_BODY_BYTES} bytes`,
  )
  const raw = await request.text()
  ensure(new TextEncoder().encode(raw).byteLength <= MAX_ENQUEUE_BODY_BYTES, 'INVALID_INPUT', `Request body must not exceed ${MAX_ENQUEUE_BODY_BYTES} bytes`)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('INVALID_INPUT', 'Body must be valid JSON')
  }
  const parsed = parseDailyRequeuePayload(body, requestedBy)
  const requeue = dependencies.requeue ?? requeueDailyPriceTargets
  const result = await requeue(pool, parsed)
  return jsonResponse({
    message: 'daily-price-targets-requeued',
    ...result,
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
  }])
  const canonicalSelection = selectEodPriceEvidence(eodTimestamp, candidates)
  const selection = source && canonicalSelection.selected?.source !== source
    ? {
        ...canonicalSelection,
        selected: null,
        validation: canonicalSelection.selected
          ? {
              status: 'unavailable' as const,
              disagreementBps: canonicalSelection.validation.disagreementBps,
              failureClass: 'not-found' as const,
              failureReason: `The accepted canonical source is ${canonicalSelection.selected.source}, not ${source}`,
            }
          : canonicalSelection.validation,
      }
    : canonicalSelection

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
