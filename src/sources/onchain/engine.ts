import { ApiError } from '../../http/errors'
import { normalizeTokenAddress } from '../../utils/chains'
import { InvalidPricingError, RecursiveDependencyError, isRetryablePricingError } from './errors'
import type {
  MarketPriceResolver,
  PriceInputEvidence,
  PriceResolutionAttempt,
  PriceResolutionFailure,
  PriceResolutionFailureReason,
  RecursiveAdapterQuote,
  RecursivePriceAdapter,
  RecursivePriceContext,
  RecursivePriceInput,
  RecursivePriceResult,
  RecursivePriceTarget,
  ResolvedPricePath,
} from './types'

const FAILURE_ORDER: PriceResolutionFailureReason[] = [
  'retryable',
  'invalid',
  'cycle',
  'max-depth',
  'unsupported',
]

function targetKey(target: RecursivePriceTarget): string {
  return [
    target.chainId,
    target.token.toLowerCase(),
    target.timestamp ?? 'latest',
    target.blockNumber ?? 'none',
  ].join(':')
}

function adapterHintKey(target: RecursivePriceTarget): string {
  return `${target.chainId}:${target.token.toLowerCase()}`
}

function normalizeTarget(target: RecursivePriceTarget): RecursivePriceTarget {
  if (
    target.timestamp != null &&
    (!Number.isSafeInteger(target.timestamp) || target.timestamp < 0)
  ) {
    throw new InvalidPricingError('timestamp must be a non-negative unix timestamp')
  }
  if (
    target.blockNumber != null &&
    (!Number.isSafeInteger(target.blockNumber) || target.blockNumber < 0)
  ) {
    throw new InvalidPricingError('blockNumber must be a non-negative safe integer')
  }
  return {
    chainId: target.chainId,
    token: normalizeTokenAddress(target.token),
    timestamp: target.timestamp ?? null,
    blockNumber: target.blockNumber ?? null,
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || 'Unknown pricing error'
}

function classifyError(error: unknown): PriceResolutionFailureReason {
  if (error instanceof RecursiveDependencyError) return error.failure.reason
  if (error instanceof ApiError) return 'retryable'
  if (error instanceof InvalidPricingError) return 'invalid'
  if (isRetryablePricingError(error)) return 'retryable'
  return 'unsupported'
}

function selectFailureReason(attempts: PriceResolutionAttempt[]): PriceResolutionFailureReason {
  return (
    FAILURE_ORDER.find((reason) => attempts.some((attempt) => attempt.reason === reason)) ??
    'unsupported'
  )
}

function toInputEvidence(input: RecursivePriceInput): PriceInputEvidence {
  const { path } = input
  return {
    chainId: path.chainId,
    token: path.token,
    observedTimestamp: path.observedTimestamp,
    priceUsd: path.priceUsd,
    source: path.source,
    adapter: path.adapter,
    ...(input.conversion ? { conversion: input.conversion } : {}),
    ...(path.inputs.length > 0 ? { inputs: path.inputs } : {}),
  }
}

function validatePath(path: ResolvedPricePath, target: RecursivePriceTarget): ResolvedPricePath {
  if (path.chainId !== target.chainId || path.token.toLowerCase() !== target.token.toLowerCase()) {
    throw new InvalidPricingError('Resolved path does not match its requested chain and token')
  }
  if (!Number.isSafeInteger(path.observedTimestamp) || path.observedTimestamp < 0) {
    throw new InvalidPricingError('Resolved path has an invalid observation timestamp')
  }
  if (!Number.isFinite(path.priceUsd) || path.priceUsd <= 0) {
    throw new InvalidPricingError('Resolved path has a non-positive or non-finite price')
  }
  for (const input of path.inputs) {
    if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
      throw new InvalidPricingError('Recursive input has a non-positive or non-finite price')
    }
  }
  return path
}

function buildAdapterPath(
  target: RecursivePriceTarget,
  adapter: RecursivePriceAdapter,
  quote: RecursiveAdapterQuote,
): ResolvedPricePath {
  const observedTimestamp =
    quote.observedTimestamp ??
    (quote.inputs.length > 0
      ? Math.min(...quote.inputs.map((input) => input.path.observedTimestamp))
      : (target.timestamp ?? Math.floor(Date.now() / 1000)))

  return validatePath(
    {
      chainId: target.chainId,
      token: target.token,
      requestedTimestamp: target.timestamp,
      observedTimestamp,
      priceUsd: quote.priceUsd,
      symbol: quote.symbol ?? null,
      confidence: quote.confidence ?? null,
      source: quote.source ?? 'derived',
      adapter: adapter.name,
      blockNumber: quote.blockNumber ?? target.blockNumber ?? null,
      inputs: quote.inputs.map(toInputEvidence),
      metadata: quote.metadata,
    },
    target,
  )
}

/**
 * Resolves a token price by walking its on-chain conversion graph: each
 * adapter converts the token into cheaper-to-price children, and recursion
 * bottoms out at the injected market resolver.
 */
export class RecursivePriceEngine {
  private readonly successful = new Map<string, ResolvedPricePath>()
  private readonly failed = new Map<string, PriceResolutionFailure>()
  private readonly inflight = new Map<string, Promise<RecursivePriceResult>>()
  private resolutions = 0

  constructor(
    private readonly marketPrice: MarketPriceResolver,
    private readonly adapters: RecursivePriceAdapter[],
    private readonly maxDepth = 8,
    private readonly adapterHints = new Map<string, string>(),
    private readonly resolutionBudget = 32,
  ) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new Error('Recursive price depth must be a positive integer')
    }
    if (!Number.isInteger(resolutionBudget) || resolutionBudget < 1) {
      throw new Error('Recursive price resolution budget must be a positive integer')
    }
  }

  async resolve(target: RecursivePriceTarget): Promise<RecursivePriceResult> {
    return this.resolveAt(normalizeTarget(target), [])
  }

  private async resolveAt(
    target: RecursivePriceTarget,
    ancestry: string[],
  ): Promise<RecursivePriceResult> {
    const key = targetKey(target)
    if (ancestry.includes(key)) {
      return { path: null, failure: { reason: 'cycle', token: target.token, attempts: [] } }
    }
    if (ancestry.length >= this.maxDepth) {
      return { path: null, failure: { reason: 'max-depth', token: target.token, attempts: [] } }
    }

    const cached = this.successful.get(key)
    if (cached) {
      return { path: cached, failure: null }
    }
    const cachedFailure = this.failed.get(key)
    if (cachedFailure) {
      return { path: null, failure: cachedFailure }
    }
    const pending = this.inflight.get(key)
    if (pending) {
      return pending
    }

    const work = this.resolveUncached(target, ancestry, key)
    this.inflight.set(key, work)
    try {
      return await work
    } finally {
      this.inflight.delete(key)
    }
  }

  private async resolveUncached(
    target: RecursivePriceTarget,
    ancestry: string[],
    key: string,
  ): Promise<RecursivePriceResult> {
    if (this.resolutions >= this.resolutionBudget) {
      const failure = { reason: 'unsupported' as const, token: target.token, attempts: [] }
      this.failed.set(key, failure)
      return { path: null, failure }
    }
    this.resolutions += 1

    const attempts: PriceResolutionAttempt[] = []
    // The root token already failed every market source before this engine ran;
    // asking again would only repeat that call. Children have not been tried.
    if (ancestry.length > 0) {
      try {
        const market = await this.marketPrice(target)
        if (market) {
          const path = validatePath(market, target)
          this.successful.set(key, path)
          return { path, failure: null }
        }
      } catch (error) {
        const reason = classifyError(error)
        attempts.push({ adapter: 'market-price', reason, error: errorMessage(error), cause: error })
        if (reason !== 'unsupported') {
          const failure = { reason, token: target.token, attempts }
          this.failed.set(key, failure)
          return { path: null, failure }
        }
      }
    }

    const nextAncestry = [...ancestry, key]
    const context: RecursivePriceContext = {
      resolve: (child) => this.resolveAt(normalizeTarget(child), nextAncestry),
      require: async (child, label) => {
        const result = await this.resolveAt(normalizeTarget(child), nextAncestry)
        if (result.path) {
          return result.path
        }
        const nested = result.failure.attempts
          .map((attempt) => `${attempt.adapter}: ${attempt.error}`)
          .join('; ')
        throw new RecursiveDependencyError(
          `${label} ${result.failure.token} is unavailable (${result.failure.reason}${nested ? `; ${nested}` : ''})`,
          result.failure,
        )
      },
    }

    const hint = this.adapterHints.get(adapterHintKey(target))
    const orderedAdapters = hint
      ? [
          ...this.adapters.filter((adapter) => adapter.name === hint),
          ...this.adapters.filter((adapter) => adapter.name !== hint),
        ]
      : this.adapters

    for (const adapter of orderedAdapters) {
      try {
        const quote = await adapter.resolve(target, context)
        if (!quote) {
          continue
        }
        const path = buildAdapterPath(target, adapter, quote)
        this.successful.set(key, path)
        this.adapterHints.set(adapterHintKey(target), adapter.name)
        return { path, failure: null }
      } catch (error) {
        attempts.push({
          adapter: adapter.name,
          reason: classifyError(error),
          error: errorMessage(error),
          cause: error,
        })
      }
    }

    const failure = {
      reason: selectFailureReason(attempts),
      token: target.token,
      attempts,
    }
    this.failed.set(key, failure)
    return { path: null, failure }
  }
}
