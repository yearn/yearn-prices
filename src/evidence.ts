import {
  SOURCE_PRIORITY,
  type PriceEvidenceCandidate,
  type PriceEvidenceKind,
  type PriceEvidenceQuality,
  type PriceEvidenceSelection,
} from './types'

export const DEFAULT_DISAGREEMENT_THRESHOLD_BPS = 1_000
export const DEFAULT_DISAGREEMENT_WINDOW_SECONDS = 6 * 60 * 60

export interface PriceEvidenceSelectionOptions {
  disagreementThresholdBps?: number
  disagreementWindowSeconds?: number
}
const sourcePriority = new Map(SOURCE_PRIORITY.map((source, index) => [source, index]))
const classificationPriority: Record<PriceEvidenceKind, number> = {
  observed: 0,
  derived: 1,
  estimated: 2,
  legacy: 3,
}
const qualityPriority: Record<PriceEvidenceQuality, number> = {
  exact: 0,
  'near-eod': 1,
  fallback: 2,
  legacy: 3,
}

function assertNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return value
}

function candidateOrder(left: PriceEvidenceCandidate, right: PriceEvidenceCandidate): number {
  return classificationPriority[left.classification] - classificationPriority[right.classification]
    || qualityPriority[left.quality] - qualityPriority[right.quality]
    || (sourcePriority.get(left.source) ?? Number.MAX_SAFE_INTEGER)
      - (sourcePriority.get(right.source) ?? Number.MAX_SAFE_INTEGER)
    || left.observationDistance - right.observationDistance
    || (left.adapter ?? '').localeCompare(right.adapter ?? '')
    || left.candidateId.localeCompare(right.candidateId)
}

function structuralFailure(candidate: PriceEvidenceCandidate, eodTimestamp: number): string | null {
  if (candidate.requestedTimestamp !== eodTimestamp) return `${candidate.source}: candidate has the wrong EOD key`
  if (!Number.isFinite(candidate.priceUsd) || candidate.priceUsd <= 0) return `${candidate.source}: invalid price`
  if (!Number.isSafeInteger(candidate.observedTimestamp) || candidate.observedTimestamp < 0) {
    return `${candidate.source}: invalid observation timestamp`
  }
  if (candidate.source === 'stable-peg') return 'stable-peg: automatic peg evidence is not strict-price eligible'
  if (candidate.validationStatus === 'legacy-unvalidated') {
    return `${candidate.source}: legacy evidence has not passed an acceptance policy`
  }
  if (candidate.validationStatus === 'quarantined') return `${candidate.source}: candidate is quarantined`
  if (candidate.classification === 'derived' && candidate.inputs.length === 0) {
    return `${candidate.source}: derived evidence has no recursive inputs`
  }
  return null
}

function independenceKey(candidate: PriceEvidenceCandidate): string {
  const configured = candidate.metadata.independenceKey
  if (typeof configured === 'string' && configured.length > 0) return configured
  if (candidate.source.startsWith('defillama')) return 'defillama'
  if (candidate.classification === 'derived') return `derived:${candidate.adapter ?? candidate.source}`
  return candidate.source
}

export function relativeDifferenceBps(left: number, right: number): number {
  const denominator = Math.max(Math.abs(left), Math.abs(right))
  return denominator === 0 ? 0 : (Math.abs(left - right) / denominator) * 10_000
}

export function selectEodPriceEvidence(
  eodTimestamp: number,
  candidates: PriceEvidenceCandidate[],
  options: PriceEvidenceSelectionOptions = {},
): PriceEvidenceSelection {
  const disagreementThresholdBps = assertNonNegative(
    options.disagreementThresholdBps ?? DEFAULT_DISAGREEMENT_THRESHOLD_BPS,
    'disagreementThresholdBps',
  )
  const disagreementWindowSeconds = assertNonNegative(
    options.disagreementWindowSeconds ?? DEFAULT_DISAGREEMENT_WINDOW_SECONDS,
    'disagreementWindowSeconds',
  )

  const ordered = [...candidates].sort(candidateOrder)
  if (ordered.length === 0) {
    return {
      selected: null,
      candidates: [],
      validation: {
        status: 'unavailable',
        disagreementBps: null,
        failureClass: 'not-found',
        failureReason: 'No candidate exists for the exact EOD key',
      },
    }
  }

  const failures = ordered.map(candidate => structuralFailure(candidate, eodTimestamp))
  const valid = ordered.filter((_, index) => failures[index] === null)
  if (valid.length === 0) {
    return {
      selected: null,
      candidates: ordered,
      validation: {
        status: 'unavailable',
        disagreementBps: null,
        failureClass: 'invalid',
        failureReason: failures.filter(reason => reason !== null).join('; '),
      },
    }
  }

  const selected = valid[0]
  const comparable = valid.filter(candidate => (
    independenceKey(candidate) !== independenceKey(selected)
    && Math.abs(selected.observedTimestamp - candidate.observedTimestamp) <= disagreementWindowSeconds
  ))
  let maximumDisagreementBps = 0
  for (const candidate of comparable) {
    maximumDisagreementBps = Math.max(
      maximumDisagreementBps,
      relativeDifferenceBps(selected.priceUsd, candidate.priceUsd),
    )
  }

  if (maximumDisagreementBps > disagreementThresholdBps) {
    return {
      selected: null,
      candidates: ordered,
      validation: {
        status: 'quarantined',
        disagreementBps: maximumDisagreementBps,
        failureClass: 'disagreement',
        failureReason: `Independent observations disagree by ${maximumDisagreementBps.toFixed(2)} bps`,
      },
    }
  }

  return {
    selected,
    candidates: ordered,
    validation: {
      status: selected.validationStatus,
      disagreementBps: comparable.length > 0 ? maximumDisagreementBps : null,
      failureClass: selected.failureReason ? 'invalid' : null,
      failureReason: selected.failureReason,
    },
  }
}
