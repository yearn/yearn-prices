import { chainNameToId } from './chains'
import { sanitizeFailureReason } from './daily-price-progress'
import { pgTimestampToUnix } from './time'

export const DAILY_EVIDENCE_EXPORT_SCHEMA_VERSION = 'yearn-prices-target-evidence/1.0.0'

export interface DailyEvidenceTargetRow {
  chain: string
  token: string
  eod_at: string | Date
  status: string
  adapter: string | null
  failure_class: string | null
  failure_reason: string | null
  metadata: unknown
}

export interface DailyEvidenceCandidateRow {
  chain: string
  token: string
  timestamp: string | Date
  price: string | number
  symbol: string | null
  confidence: string | number | null
  source: string
  candidate_id: string
  observed_at: string | Date | null
  evidence_kind: string | null
  quality: string | null
  adapter: string | null
  block_number: string | number | bigint | null
  input_evidence: unknown
  validation_status: string | null
  failure_reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function nullableNumber(value: string | number | bigint | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function candidateKey(row: Pick<DailyEvidenceCandidateRow, 'chain' | 'token'>): string {
  return `${row.chain}:${row.token.toLowerCase()}`
}

function candidateEvidence(row: DailyEvidenceCandidateRow) {
  return {
    candidateId: row.candidate_id,
    priceUsd: Number(row.price),
    symbol: row.symbol,
    confidence: nullableNumber(row.confidence),
    source: row.source,
    adapter: row.adapter,
    classification: row.evidence_kind,
    quality: row.quality,
    observedTimestamp: row.observed_at == null ? null : pgTimestampToUnix(row.observed_at),
    blockNumber: nullableNumber(row.block_number),
    validationState: row.validation_status ?? 'unavailable',
    failureReason: sanitizeFailureReason(row.failure_reason),
    recursiveInputEvidence: safeArray(row.input_evidence),
  }
}

export function buildDailyEvidenceExport(
  eodTimestamp: number,
  targets: DailyEvidenceTargetRow[],
  candidates: DailyEvidenceCandidateRow[],
) {
  const candidatesByTarget = new Map<string, DailyEvidenceCandidateRow[]>()
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    const rows = candidatesByTarget.get(key) ?? []
    rows.push(candidate)
    candidatesByTarget.set(key, rows)
  }

  const orderedTargets = [...targets].sort((left, right) => (
    (chainNameToId(left.chain) ?? Number.MAX_SAFE_INTEGER) - (chainNameToId(right.chain) ?? Number.MAX_SAFE_INTEGER)
      || left.token.toLowerCase().localeCompare(right.token.toLowerCase())
  ))
  const outcomes = { priced: 0, unavailable: 0, quarantined: 0 }

  const targetEvidence = orderedTargets.map(target => {
    const metadata = isRecord(target.metadata) ? target.metadata : {}
    const rows = [...(candidatesByTarget.get(candidateKey(target)) ?? [])]
      .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id))
    const selectedCandidateId = typeof metadata.candidateId === 'string' ? metadata.candidateId : null
    const selected = rows.find(row => row.candidate_id === selectedCandidateId) ?? null
    const outcome = target.status === 'priced'
      ? 'priced'
      : target.status === 'quarantined'
        ? 'quarantined'
        : 'unavailable'
    outcomes[outcome] += 1

    return {
      chainId: typeof metadata.chainId === 'number' ? metadata.chainId : chainNameToId(target.chain),
      chain: target.chain,
      token: target.token.toLowerCase(),
      eodTimestamp,
      status: outcome,
      failureClass: target.failure_class ?? metadata.resolutionFailure ?? null,
      failureReason: sanitizeFailureReason(target.failure_reason),
      source: selected?.source ?? (typeof metadata.source === 'string' ? metadata.source : null),
      adapter: selected?.adapter ?? target.adapter,
      classification: selected?.evidence_kind ?? (typeof metadata.classification === 'string' ? metadata.classification : null),
      quality: selected?.quality ?? (typeof metadata.quality === 'string' ? metadata.quality : null),
      observedTimestamp: selected?.observed_at == null ? null : pgTimestampToUnix(selected.observed_at),
      validationState: selected?.validation_status ?? (outcome === 'quarantined' ? 'quarantined' : 'unavailable'),
      recursiveInputEvidence: selected == null ? [] : safeArray(selected.input_evidence),
      inventory: {
        key: typeof metadata.inventoryKey === 'string' ? metadata.inventoryKey : null,
        roles: safeArray(metadata.roles),
        requirements: safeArray(metadata.requirements),
        origins: safeArray(metadata.origins),
        producerSupport: typeof metadata.producerSupport === 'string' ? metadata.producerSupport : null,
        consumerSupport: typeof metadata.consumerSupport === 'string' ? metadata.consumerSupport : null,
      },
      candidates: rows.map(candidateEvidence),
    }
  })

  return {
    schemaVersion: DAILY_EVIDENCE_EXPORT_SCHEMA_VERSION,
    eodTimestamp,
    eod: new Date(eodTimestamp * 1000).toISOString(),
    targetCount: targetEvidence.length,
    outcomes,
    targets: targetEvidence,
  }
}
