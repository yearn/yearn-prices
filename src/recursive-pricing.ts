import { normalizeTokenAddress } from './chains'
import {
  ONCHAIN_ADAPTER_VERSION,
  PRICE_SELECTION_POLICY_VERSION,
  priceCandidateId,
} from './candidate-identity'
import { selectEodPriceEvidence, type PriceEvidenceSelectionOptions } from './evidence'
import { sanitizeFailureReason } from './daily-price-progress'
import { normalizeToEndOfDay } from './time'
import type {
  PriceEvidenceCandidate,
  PriceEvidenceInput,
  PriceEvidenceKind,
  PriceEvidenceQuality,
  PriceSource,
} from './types'

export interface RecursivePriceTarget {
  chain: string
  token: string
  requestedTimestamp: number
  blockNumber?: number | null
}

export interface ResolvedPricePath {
  chain: string
  token: string
  requestedTimestamp: number
  observedTimestamp: number
  priceUsd: number
  symbol: string | null
  confidence: number | null
  source: PriceSource
  adapter: string
  classification: Exclude<PriceEvidenceKind, 'legacy'>
  quality: Exclude<PriceEvidenceQuality, 'legacy'>
  blockNumber: number | null
  inputs: PriceEvidenceInput[]
  metadata: Record<string, unknown>
}

export type PriceResolutionFailureReason =
  | 'cycle'
  | 'max-depth'
  | 'retryable'
  | 'unsupported'
  | 'invalid'
  | 'disagreement'

export interface PriceResolutionAttempt {
  adapter: string
  reason: PriceResolutionFailureReason
  error: string
}

export interface PriceResolutionFailure {
  reason: PriceResolutionFailureReason
  token: string
  attempts: PriceResolutionAttempt[]
}

export type RecursivePriceResult =
  | { path: ResolvedPricePath; candidates?: ResolvedPricePath[]; failure: null }
  | { path: null; candidates?: ResolvedPricePath[]; failure: PriceResolutionFailure }

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
  source?: PriceSource
  classification?: Exclude<PriceEvidenceKind, 'legacy'>
  quality?: Exclude<PriceEvidenceQuality, 'legacy'>
  blockNumber?: number | null
}

export interface RecursivePriceContext {
  resolve(target: RecursivePriceTarget): Promise<RecursivePriceResult>
  require(target: RecursivePriceTarget, label: string): Promise<ResolvedPricePath>
}

export interface RecursivePriceAdapter {
  name: string
  resolve(target: RecursivePriceTarget, context: RecursivePriceContext): Promise<RecursiveAdapterQuote | null>
}

export type HistoricalMarketPriceResolver = ((
  target: RecursivePriceTarget,
) => Promise<ResolvedPricePath | null>) & {
  prefetch?: (targets: RecursivePriceTarget[]) => Promise<void>
  unavailableAttempts?: (target: RecursivePriceTarget) => PriceResolutionAttempt[]
}

export class RetryablePricingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryablePricingError'
  }
}

export class InvalidPricingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InvalidPricingError'
  }
}

export class DisagreementPricingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DisagreementPricingError'
  }
}

class RecursiveDependencyError extends Error {
  constructor(
    message: string,
    readonly failure: PriceResolutionFailure,
  ) {
    super(message)
    this.name = 'RecursiveDependencyError'
  }
}

const QUALITY_ORDER: Record<Exclude<PriceEvidenceQuality, 'legacy'>, number> = {
  exact: 0,
  'near-eod': 1,
  fallback: 2,
}

const FAILURE_ORDER: PriceResolutionFailureReason[] = [
  'retryable',
  'disagreement',
  'invalid',
  'cycle',
  'max-depth',
  'unsupported',
]

function targetKey(target: RecursivePriceTarget): string {
  return [
    target.chain,
    target.token.toLowerCase(),
    target.requestedTimestamp,
    target.blockNumber ?? 'none',
  ].join(':')
}

function adapterHintKey(target: RecursivePriceTarget): string {
  return `${target.chain}:${target.token.toLowerCase()}`
}

function normalizeTarget(target: RecursivePriceTarget): RecursivePriceTarget {
  if (!Number.isSafeInteger(target.requestedTimestamp) || target.requestedTimestamp < 0) {
    throw new InvalidPricingError('requestedTimestamp must be a non-negative unix timestamp')
  }
  if (normalizeToEndOfDay(target.requestedTimestamp) !== target.requestedTimestamp) {
    throw new InvalidPricingError('Recursive pricing requires an exact UTC EOD timestamp')
  }
  if (target.blockNumber != null && (!Number.isSafeInteger(target.blockNumber) || target.blockNumber < 0)) {
    throw new InvalidPricingError('blockNumber must be a non-negative safe integer')
  }
  return {
    chain: target.chain.toLowerCase(),
    token: normalizeTokenAddress(target.token),
    requestedTimestamp: target.requestedTimestamp,
    blockNumber: target.blockNumber ?? null,
  }
}

function errorMessage(error: unknown): string {
  return sanitizeFailureReason(error instanceof Error ? error.message : String(error)) ?? 'Unknown pricing error'
}

export function isRetryablePricingError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof RetryablePricingError) return true
    if (!(current instanceof Error)) break
    const message = current.message.toLowerCase()
    if (message.includes('revert') || message.includes('returned no data')) return false
    if (
      current.name === 'HttpRequestError'
      || current.name === 'RpcRequestError'
      || current.name === 'UnknownRpcError'
      || current.name === 'TimeoutError'
      || current.name === 'SocketError'
      || message.includes('http request failed')
      || message.includes('rpc request failed')
      || message.includes('unknown rpc error occurred')
      || message.includes('fetch failed')
      || message.includes('timed out')
      || /http (408|425|429|5\d\d)/.test(message)
      || /status (408|425|429|5\d\d)/.test(message)
    ) {
      return true
    }
    current = 'cause' in current ? current.cause : null
  }
  return false
}

function classifyError(error: unknown): PriceResolutionFailureReason {
  if (error instanceof RecursiveDependencyError) return error.failure.reason
  if (error instanceof DisagreementPricingError) return 'disagreement'
  if (error instanceof InvalidPricingError) return 'invalid'
  if (isRetryablePricingError(error)) return 'retryable'
  return 'unsupported'
}

function selectFailureReason(attempts: PriceResolutionAttempt[]): PriceResolutionFailureReason {
  return FAILURE_ORDER.find(reason => attempts.some(attempt => attempt.reason === reason)) ?? 'unsupported'
}

function weakestQuality(
  requested: Exclude<PriceEvidenceQuality, 'legacy'>,
  inputs: RecursivePriceInput[],
): Exclude<PriceEvidenceQuality, 'legacy'> {
  return inputs.reduce((weakest, input) => (
    QUALITY_ORDER[input.path.quality] > QUALITY_ORDER[weakest] ? input.path.quality : weakest
  ), requested)
}

function toEvidenceInput(input: RecursivePriceInput): PriceEvidenceInput {
  const { path } = input
  return {
    chain: path.chain,
    token: path.token,
    observedTimestamp: path.observedTimestamp,
    priceUsd: path.priceUsd,
    source: path.source,
    adapter: path.adapter,
    classification: path.classification,
    quality: path.quality,
    ...(input.conversion ? { conversion: input.conversion } : {}),
    ...(path.inputs.length > 0 ? { inputs: path.inputs } : {}),
  }
}

function validatePath(path: ResolvedPricePath, target: RecursivePriceTarget): ResolvedPricePath {
  if (path.chain !== target.chain || path.token.toLowerCase() !== target.token.toLowerCase()) {
    throw new InvalidPricingError('Resolved path does not match its requested chain and token')
  }
  if (path.requestedTimestamp !== target.requestedTimestamp) {
    throw new InvalidPricingError('Resolved path does not match its requested timestamp')
  }
  if (!Number.isSafeInteger(path.observedTimestamp) || path.observedTimestamp < 0) {
    throw new InvalidPricingError('Resolved path has an invalid observation timestamp')
  }
  if (path.observedTimestamp > target.requestedTimestamp) {
    throw new InvalidPricingError('Resolved path contains a future observation')
  }
  if (!Number.isFinite(path.priceUsd) || path.priceUsd <= 0) {
    throw new InvalidPricingError('Resolved path has a non-positive or non-finite price')
  }
  if (path.source === 'stable-peg') {
    throw new InvalidPricingError('Automatic stablecoin peg evidence is not strict-price eligible')
  }
  if (path.classification === 'derived' && path.inputs.length === 0) {
    throw new InvalidPricingError('Derived price is missing recursive input provenance')
  }
  for (const input of path.inputs) {
    if (!Number.isSafeInteger(input.observedTimestamp) || input.observedTimestamp < 0) {
      throw new InvalidPricingError('Recursive input has an invalid observation timestamp')
    }
    if (input.observedTimestamp > target.requestedTimestamp) {
      throw new InvalidPricingError('Recursive input contains a future observation')
    }
    if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
      throw new InvalidPricingError('Recursive input has a non-positive or non-finite price')
    }
    if (input.source === 'stable-peg' || input.classification === 'legacy' || input.quality === 'legacy') {
      throw new InvalidPricingError('Recursive input is not strict-price eligible')
    }
  }
  if (
    path.classification === 'derived'
    && path.observedTimestamp > Math.min(...path.inputs.map(input => input.observedTimestamp))
  ) {
    throw new InvalidPricingError('Derived observation timestamp hides a staler recursive input')
  }
  return path
}

function pathToCandidate(path: ResolvedPricePath): PriceEvidenceCandidate {
  const observationOffsetSeconds = path.observedTimestamp - path.requestedTimestamp
  return {
    chain: path.chain,
    token: path.token,
    requestedTimestamp: path.requestedTimestamp,
    observedTimestamp: path.observedTimestamp,
    observationDistance: Math.abs(observationOffsetSeconds),
    observationOffsetSeconds,
    observationDirection: observationOffsetSeconds === 0 ? 'exact' : observationOffsetSeconds < 0 ? 'before' : 'after',
    priceUsd: path.priceUsd,
    symbol: path.symbol,
    confidence: path.confidence,
    source: path.source,
    candidateId: priceCandidateId(path),
    adapter: path.adapter,
    classification: path.classification,
    quality: path.quality,
    blockNumber: path.blockNumber,
    inputs: path.inputs,
    validationStatus: 'validated',
    failureReason: null,
    metadata: path.metadata,
  }
}

function buildAdapterPath(
  target: RecursivePriceTarget,
  adapter: RecursivePriceAdapter,
  quote: RecursiveAdapterQuote,
): ResolvedPricePath {
  const classification = quote.classification ?? 'derived'
  if (classification === 'derived' && quote.inputs.length === 0) {
    throw new InvalidPricingError(`${adapter.name} produced a derived price without inputs`)
  }
  const observedTimestamp = quote.observedTimestamp
    ?? (quote.inputs.length > 0
      ? Math.min(...quote.inputs.map(input => input.path.observedTimestamp))
      : target.requestedTimestamp)
  const requestedQuality = quote.quality
    ?? (observedTimestamp === target.requestedTimestamp ? 'exact' : 'near-eod')

  return validatePath({
    chain: target.chain,
    token: target.token,
    requestedTimestamp: target.requestedTimestamp,
    observedTimestamp,
    priceUsd: quote.priceUsd,
    symbol: quote.symbol ?? null,
    confidence: quote.confidence ?? null,
    source: quote.source ?? 'derived',
    adapter: adapter.name,
    classification,
    quality: weakestQuality(requestedQuality, quote.inputs),
    blockNumber: quote.blockNumber ?? target.blockNumber ?? null,
    inputs: quote.inputs.map(toEvidenceInput),
    metadata: {
      ...quote.metadata,
      adapterVersion: typeof quote.metadata.adapterVersion === 'string'
        ? quote.metadata.adapterVersion
        : ONCHAIN_ADAPTER_VERSION,
      policyVersion: PRICE_SELECTION_POLICY_VERSION,
    },
  }, target)
}

export class RecursivePriceEngine {
  private readonly successful = new Map<string, ResolvedPricePath>()

  constructor(
    private readonly marketPrice: HistoricalMarketPriceResolver,
    private readonly adapters: RecursivePriceAdapter[],
    private readonly maxDepth = 8,
    private readonly selectionOptions: PriceEvidenceSelectionOptions = {},
    private readonly adapterHints = new Map<string, string>(),
  ) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new Error('Recursive price depth must be a positive integer')
    }
  }

  resolve(target: RecursivePriceTarget): Promise<RecursivePriceResult> {
    return this.resolveAt(normalizeTarget(target), [])
  }

  resolveCandidates(target: RecursivePriceTarget): Promise<RecursivePriceResult> {
    return this.resolveAllAt(normalizeTarget(target), [])
  }

  async prefetch(targets: RecursivePriceTarget[]): Promise<void> {
    await this.marketPrice.prefetch?.(targets.map(normalizeTarget))
  }

  private async resolveAt(
    target: RecursivePriceTarget,
    ancestry: string[],
  ): Promise<RecursivePriceResult> {
    const key = targetKey(target)
    if (ancestry.includes(key)) {
      return {
        path: null,
        failure: { reason: 'cycle', token: target.token, attempts: [] },
      }
    }
    if (ancestry.length >= this.maxDepth) {
      return {
        path: null,
        failure: { reason: 'max-depth', token: target.token, attempts: [] },
      }
    }

    const cached = this.successful.get(key)
    if (cached) return { path: cached, failure: null }

    const attempts: PriceResolutionAttempt[] = []
    try {
      const market = await this.marketPrice(target)
      if (market) {
        const path = validatePath(market, target)
        this.successful.set(key, path)
        return { path, failure: null }
      }
    } catch (error) {
      const reason = classifyError(error)
      attempts.push({ adapter: 'historical-market-price', reason, error: errorMessage(error) })
      if (reason !== 'unsupported') {
        return {
          path: null,
          failure: { reason, token: target.token, attempts },
        }
      }
    }

    const nextAncestry = [...ancestry, key]
    const context: RecursivePriceContext = {
      resolve: child => this.resolveAt(normalizeTarget(child), nextAncestry),
      require: async (child, label) => {
        const result = await this.resolveAt(normalizeTarget(child), nextAncestry)
        if (result.path) return result.path
        const nested = result.failure.attempts
          .map(attempt => `${attempt.adapter}: ${attempt.error}`)
          .join('; ')
        const message = `${label} ${result.failure.token} is unavailable (${result.failure.reason}${nested ? `; ${nested}` : ''})`
        throw new RecursiveDependencyError(message, result.failure)
      },
    }

    const hint = this.adapterHints.get(adapterHintKey(target))
    const orderedAdapters = hint
      ? [
          ...this.adapters.filter(adapter => adapter.name === hint),
          ...this.adapters.filter(adapter => adapter.name !== hint),
        ]
      : this.adapters
    attempts.push(...(this.marketPrice.unavailableAttempts?.(target) ?? []))

    for (const adapter of orderedAdapters) {
      try {
        const quote = await adapter.resolve(target, context)
        if (!quote) continue
        const path = buildAdapterPath(target, adapter, quote)
        this.successful.set(key, path)
        this.adapterHints.set(adapterHintKey(target), adapter.name)
        return { path, failure: null }
      } catch (error) {
        const reason = classifyError(error)
        attempts.push({ adapter: adapter.name, reason, error: errorMessage(error) })
      }
    }

    return {
      path: null,
      failure: {
        reason: selectFailureReason(attempts),
        token: target.token,
        attempts,
      },
    }
  }

  private async resolveAllAt(
    target: RecursivePriceTarget,
    ancestry: string[],
  ): Promise<RecursivePriceResult> {
    if (ancestry.includes(targetKey(target))) {
      return { path: null, candidates: [], failure: { reason: 'cycle', token: target.token, attempts: [] } }
    }
    if (ancestry.length >= this.maxDepth) {
      return { path: null, candidates: [], failure: { reason: 'max-depth', token: target.token, attempts: [] } }
    }

    const candidates: ResolvedPricePath[] = []
    const attempts: PriceResolutionAttempt[] = []
    try {
      const market = await this.marketPrice(target)
      if (market) candidates.push(validatePath(market, target))
    } catch (error) {
      const reason = classifyError(error)
      attempts.push({ adapter: 'historical-market-price', reason, error: errorMessage(error) })
    }

    attempts.push(...(this.marketPrice.unavailableAttempts?.(target) ?? []))
    const nextAncestry = [...ancestry, targetKey(target)]
    const context: RecursivePriceContext = {
      resolve: child => this.resolveAt(normalizeTarget(child), nextAncestry),
      require: async (child, label) => {
        const result = await this.resolveAt(normalizeTarget(child), nextAncestry)
        if (result.path) return result.path
        const nested = result.failure.attempts
          .map(attempt => `${attempt.adapter}: ${attempt.error}`)
          .join('; ')
        throw new RecursiveDependencyError(
          `${label} ${result.failure.token} is unavailable (${result.failure.reason}${nested ? `; ${nested}` : ''})`,
          result.failure,
        )
      },
    }

    for (const adapter of this.adapters) {
      try {
        const quote = await adapter.resolve(target, context)
        if (!quote) continue
        candidates.push(buildAdapterPath(target, adapter, quote))
      } catch (error) {
        const reason = classifyError(error)
        attempts.push({ adapter: adapter.name, reason, error: errorMessage(error) })
      }
    }

    const distinct = [...new Map(
      candidates.map(candidate => [
        `${candidate.source}:${priceCandidateId(candidate)}`,
        candidate,
      ]),
    ).values()]
    if (distinct.length === 0) {
      return {
        path: null,
        candidates: [],
        failure: { reason: selectFailureReason(attempts), token: target.token, attempts },
      }
    }

    const selection = selectEodPriceEvidence(
      target.requestedTimestamp,
      distinct.map(pathToCandidate),
      this.selectionOptions,
    )
    if (!selection.selected) {
      const reason = selection.validation.failureClass === 'disagreement' ? 'disagreement' : 'invalid'
      return {
        path: null,
        candidates: distinct,
        failure: {
          reason,
          token: target.token,
          attempts: [
            ...attempts,
            {
              adapter: 'candidate-selection',
              reason,
              error: selection.validation.failureReason ?? 'No candidate passed selection',
            },
          ],
        },
      }
    }

    const selected = distinct.find(candidate => (
      candidate.source === selection.selected?.source
      && priceCandidateId(candidate) === selection.selected.candidateId
    ))
    if (!selected) {
      return {
        path: null,
        candidates: distinct,
        failure: {
          reason: 'invalid',
          token: target.token,
          attempts: [{ adapter: 'candidate-selection', reason: 'invalid', error: 'Selected candidate identity was lost' }],
        },
      }
    }
    this.successful.set(targetKey(target), selected)
    this.adapterHints.set(adapterHintKey(target), selected.adapter)
    return { path: selected, candidates: distinct, failure: null }
  }
}

export function scaledRaw(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new InvalidPricingError('Token decimals must be an integer between 0 and 255')
  }
  const value = Number(raw) / 10 ** decimals
  if (!Number.isFinite(value)) throw new InvalidPricingError('Token amount exceeds numeric pricing range')
  return value
}

export function calculateWrapperPrice(
  convertedAssetsRaw: bigint,
  underlyingDecimals: number,
  oneShareRaw: bigint,
  shareDecimals: number,
  underlyingPrice: number,
): number {
  const shares = scaledRaw(oneShareRaw, shareDecimals)
  if (shares <= 0) throw new InvalidPricingError('Wrapper share amount must be positive')
  const price = (scaledRaw(convertedAssetsRaw, underlyingDecimals) / shares) * underlyingPrice
  if (!Number.isFinite(price) || price <= 0) throw new InvalidPricingError('Wrapper produced an invalid price')
  return price
}

export function calculateCompoundTokenPrice(
  exchangeRateRaw: bigint,
  tokenDecimals: number,
  underlyingDecimals: number,
  underlyingPrice: number,
): number {
  const exponent = 18 + underlyingDecimals - tokenDecimals
  if (exponent < 0 || exponent > 255) {
    throw new InvalidPricingError('Compound exchange-rate scale is invalid')
  }
  const price = (Number(exchangeRateRaw) / 10 ** exponent) * underlyingPrice
  if (!Number.isFinite(price) || price <= 0) throw new InvalidPricingError('Compound produced an invalid price')
  return price
}

export interface PoolNavInput {
  address: string
  balanceRaw: bigint
  decimals: number
  priceUsd: number
}

export function calculatePoolNavPrice(
  assets: PoolNavInput[],
  totalSupplyRaw: bigint,
  poolDecimals: number,
  excludedPoolBalanceRaw = 0n,
): number {
  const circulatingSupply = scaledRaw(totalSupplyRaw - excludedPoolBalanceRaw, poolDecimals)
  if (circulatingSupply <= 0) throw new InvalidPricingError('Pool token has no circulating supply')
  if (assets.length === 0) throw new InvalidPricingError('Pool has no priced constituents')
  let nav = 0
  for (const asset of assets) {
    if (!Number.isFinite(asset.priceUsd) || asset.priceUsd <= 0) {
      throw new InvalidPricingError(`Invalid price for pool constituent ${asset.address}`)
    }
    nav += scaledRaw(asset.balanceRaw, asset.decimals) * asset.priceUsd
  }
  const price = nav / circulatingSupply
  if (!Number.isFinite(price) || price <= 0) throw new InvalidPricingError('Pool NAV produced an invalid price')
  return price
}
