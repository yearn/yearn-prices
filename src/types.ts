export const SOURCE_PRIORITY = [
  'defillama',
  'defillama-canonical-market-proxy',
  'defillama-coingecko-alias',
  'on-chain-oracle',
  'bobs-api',
  'curve',
  'derived',
  'enso',
  'binance',
  'stable-peg',
] as const

export type PriceSource = (typeof SOURCE_PRIORITY)[number]

export const PRICE_EVIDENCE_KINDS = ['observed', 'derived', 'estimated', 'legacy'] as const
export type PriceEvidenceKind = (typeof PRICE_EVIDENCE_KINDS)[number]

export const PRICE_EVIDENCE_QUALITIES = ['exact', 'near-eod', 'fallback', 'legacy'] as const
export type PriceEvidenceQuality = (typeof PRICE_EVIDENCE_QUALITIES)[number]

export const PRICE_VALIDATION_STATUSES = ['validated', 'legacy-unvalidated', 'quarantined'] as const
export type PriceValidationStatus = (typeof PRICE_VALIDATION_STATUSES)[number]

export type PriceObservationDirection = 'before' | 'exact' | 'after'

export type PriceEvidenceFailureClass = 'not-found' | 'invalid' | 'disagreement' | 'unsupported' | 'retryable'

export interface Env {
  DATABASE_URL: string
  ENSO_API_KEY?: string
  [key: string]: string | undefined
}

export interface ParsedTokenKey {
  chain: string
  token: `0x${string}`
  tokenKey: string
}

export interface DbPriceRow {
  chain: string
  token: string
  timestamp: string | Date
  price: string | number
  symbol: string | null
  confidence: string | number | null
  source: PriceSource
}

export interface DbPriceEvidenceRow extends DbPriceRow {
  requested_timestamp: string | Date
  observed_timestamp: string | Date
  evidence_kind: PriceEvidenceKind | null
  quality: PriceEvidenceQuality | null
  adapter: string | null
  block_number: string | number | bigint | null
  input_evidence: unknown
  validation_status: PriceValidationStatus | null
  failure_reason: string | null
  evidence_metadata: unknown
}

export interface PricePoint {
  timestamp: number
  price: number
  confidence: number | null
  source: PriceSource
}

export interface PriceEvidenceInput {
  chain: string
  token: string
  observedTimestamp: number
  priceUsd: number
  source: string
  adapter: string | null
  classification: PriceEvidenceKind
  quality: PriceEvidenceQuality
  conversion?: Record<string, unknown>
  inputs?: PriceEvidenceInput[]
}

export interface PriceEvidenceCandidate {
  chain: string
  token: string
  requestedTimestamp: number
  observedTimestamp: number
  observationDistance: number
  observationOffsetSeconds: number
  observationDirection: PriceObservationDirection
  priceUsd: number
  symbol: string | null
  confidence: number | null
  source: PriceSource
  adapter: string | null
  classification: PriceEvidenceKind
  quality: PriceEvidenceQuality
  blockNumber: number | null
  inputs: PriceEvidenceInput[]
  validationStatus: PriceValidationStatus
  failureReason: string | null
  metadata: Record<string, unknown>
}

export interface PriceEvidenceValidation {
  status: PriceValidationStatus | 'unavailable'
  disagreementBps: number | null
  failureClass: PriceEvidenceFailureClass | null
  failureReason: string | null
}

export interface PriceEvidenceSelection {
  selected: PriceEvidenceCandidate | null
  candidates: PriceEvidenceCandidate[]
  validation: PriceEvidenceValidation
}

export interface ExactPriceRecord extends PricePoint {
  chain: string
  token: string
  symbol: string | null
}

export interface BatchPriceRecord extends ExactPriceRecord {}

export interface HistoricalRequestTuple {
  chain: string
  token: string
  timestamp: number
}

export interface SpotRequest {
  chain: string
  token: `0x${string}`
  originalKey: string
}

export interface RangeRequest {
  chain: string
  token: string
  startTimestamp: number
  endTimestamp: number
}

export interface HistoricalResponseCoin {
  price: number
  symbol: string | null
  timestamp: number
  confidence: number | null
  source: PriceSource
}

export interface BatchHistoricalResponseCoin {
  symbol: string | null
  prices: PricePoint[]
}

export interface ErrorPayload<C extends string = string> {
  code: C
  message: string
}

export type ErrorBody<C extends string = string> = {
  error: ErrorPayload<C>
}

export type SpotTokenErrorCode = 'NOT_FOUND' | 'UNAVAILABLE'

export type SpotErrorResponseCoin = ErrorBody<SpotTokenErrorCode>

export type SpotResponseCoin = BatchHistoricalResponseCoin | SpotErrorResponseCoin

export interface TokenPriceWrite {
  chain: string
  token: string
  timestamp: number
  price: number | string
  symbol: string | null
  confidence: number | string | null
  source: PriceSource
  observedTimestamp?: number | null
  classification?: PriceEvidenceKind | null
  quality?: PriceEvidenceQuality | null
  adapter?: string | null
  blockNumber?: number | null
  inputs?: PriceEvidenceInput[]
  validationStatus?: PriceValidationStatus | null
  failureReason?: string | null
  metadata?: Record<string, unknown>
}

export interface KongVaultListItem {
  chainId: number
  address: string
  symbol: string | null
  apiVersion: string | null
  decimals: number | null
  asset?: {
    address: string
    symbol?: string | null
    decimals?: number | null
  } | null
}

export interface DefiLlamaHistoricalCoin {
  price: number
  symbol?: string
  timestamp: number
  confidence?: number | null
  decimals?: number
}

export interface DefiLlamaHistoricalResponse {
  coins: Record<string, DefiLlamaHistoricalCoin>
}

export interface DefiLlamaBatchCoin {
  symbol?: string
  prices: Array<{
    timestamp: number
    price: number
    confidence?: number | null
  }>
}

export interface DefiLlamaBatchResponse {
  coins: Record<string, DefiLlamaBatchCoin>
}

export interface EnsoPriceResponse {
  decimals: number
  price: number
  address: string
  chainId: number
  symbol?: string
  timestamp?: number
  confidence?: number
}
