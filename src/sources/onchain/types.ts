import type { PriceSource } from '../../types'

export type ResolvedPriceSource = PriceSource | 'db'

/**
 * A price request the engine resolves. `timestamp` null means "latest";
 * `blockNumber` pins the read so every node of one resolution tree shares
 * a block.
 */
export interface RecursivePriceTarget {
  chainId: number
  token: string
  timestamp: number | null
  blockNumber?: number | null
}

export interface ResolvedPricePath {
  chainId: number
  token: string
  requestedTimestamp: number | null
  observedTimestamp: number
  priceUsd: number
  symbol: string | null
  confidence: number | null
  source: ResolvedPriceSource
  adapter: string
  blockNumber: number | null
  inputs: PriceInputEvidence[]
  metadata: Record<string, unknown>
}

export interface PriceInputEvidence {
  chainId: number
  token: string
  observedTimestamp: number
  priceUsd: number
  symbol: string | null
  confidence: number | null
  source: ResolvedPriceSource
  adapter: string
  conversion?: Record<string, unknown>
  inputs?: PriceInputEvidence[]
}

export type PriceResolutionFailureReason = 'cycle' | 'max-depth' | 'retryable' | 'budget' | 'unsupported' | 'invalid'

export interface PriceResolutionAttempt {
  adapter: string
  reason: PriceResolutionFailureReason
  error: string
  /** The thrown value, kept so a transient failure can be rethrown as-is. */
  cause?: unknown
}

export interface PriceResolutionFailure {
  reason: PriceResolutionFailureReason
  token: string
  attempts: PriceResolutionAttempt[]
}

export type RecursivePriceResult =
  | { path: ResolvedPricePath; failure: null }
  | { path: null; failure: PriceResolutionFailure }

export interface RecursivePriceInput {
  path: ResolvedPricePath
  conversion?: Record<string, unknown>
}

export interface RecursiveAdapterQuote {
  priceUsd: number
  inputs: RecursivePriceInput[]
  metadata: Record<string, unknown>
  observedTimestamp?: number
  symbol?: string | null
  confidence?: number | null
  source?: ResolvedPriceSource
  blockNumber?: number | null
}

export interface RecursivePriceContext {
  /** Resolves a child price, returning the failure instead of throwing. */
  resolve(target: RecursivePriceTarget): Promise<RecursivePriceResult>
  /** Resolves a child price, throwing when it is unavailable. */
  require(target: RecursivePriceTarget, label: string): Promise<ResolvedPricePath>
}

export interface RecursivePriceAdapter {
  name: string
  resolve(target: RecursivePriceTarget, context: RecursivePriceContext): Promise<RecursiveAdapterQuote | null>
}

/**
 * Prices a token from an off-chain source. Injected by the registry so the
 * engine never reaches back into it, and so recursion always terminates at a
 * market price.
 */
export type MarketPriceResolver = (target: RecursivePriceTarget) => Promise<ResolvedPricePath | null>
