import type { Pool } from '@neondatabase/serverless'
import { normalizeTokenAddress, normalizeTokenKey } from './chains'
import {
  HISTORICAL_MARKET_ADAPTER_VERSION,
  PRICE_SELECTION_POLICY_VERSION,
} from './candidate-identity'
import { DefiLlamaClient } from './defillama'
import {
  getDefiLlamaCoinGeckoAlias,
  isDefiLlamaAliasValidAt,
  type DefiLlamaCoinGeckoAlias,
} from './defillama-aliases'
import { selectEodPriceEvidence, type PriceEvidenceSelectionOptions } from './evidence'
import { getHistoricalPriceEvidenceCandidates } from './queries'
import {
  DisagreementPricingError,
  InvalidPricingError,
  type HistoricalMarketPriceResolver,
  type RecursivePriceTarget,
  type ResolvedPricePath,
} from './recursive-pricing'
import type {
  DefiLlamaBatchCoin,
  DefiLlamaHistoricalCoin,
  PriceEvidenceCandidate,
  PriceObservationDirection,
} from './types'

export interface HistoricalMarketResolverOptions extends PriceEvidenceSelectionOptions {
  searchWidth?: string
  batchSize?: number
  batchConcurrency?: number
  batchDelayMs?: number
  allowProductionDailyImport?: boolean
}

export interface HistoricalMarketResolverDependencies {
  defiLlama?: Pick<DefiLlamaClient, 'getHistorical'> & Partial<Pick<DefiLlamaClient, 'getBatchHistorical'>>
  loadCandidates?: typeof getHistoricalPriceEvidenceCandidates
}

interface ProviderCacheEntry {
  resolution: ProviderResolution | null
  error: unknown | null
}

interface ProviderResolution {
  coin: DefiLlamaHistoricalCoin
  matchedIdentifier: string
  lookupKind: 'direct' | 'coingecko-alias' | 'canonical-market-proxy'
  alias: DefiLlamaCoinGeckoAlias | null
}

interface PendingProviderTarget {
  target: RecursivePriceTarget
  waiters: Array<{
    resolve: (resolution: ProviderResolution | null) => void
    reject: (error: unknown) => void
  }>
}

const DEFAULT_BATCH_SIZE = 75
const DEFAULT_BATCH_CONCURRENCY = 2
const DEFAULT_BATCH_DELAY_MS = 25

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex]
        nextIndex += 1
        await worker(value)
      }
    },
  ))
}

function providerTargetKey(target: RecursivePriceTarget): string {
  return `${normalizeTokenKey(target.chain, target.token).toLowerCase()}:${target.requestedTimestamp}`
}

function providerTokenKey(target: RecursivePriceTarget): string {
  return normalizeTokenKey(target.chain, target.token)
}

function eligibleAlias(target: RecursivePriceTarget): DefiLlamaCoinGeckoAlias | null {
  const alias = getDefiLlamaCoinGeckoAlias(target.chain, target.token)
  return alias && isDefiLlamaAliasValidAt(alias, target.requestedTimestamp) ? alias : null
}

function providerIdentifiers(target: RecursivePriceTarget): string[] {
  const direct = providerTokenKey(target)
  const alias = eligibleAlias(target)?.identifier
  return alias ? [direct, alias] : [direct]
}

function normalizeMarketTarget(target: RecursivePriceTarget): RecursivePriceTarget {
  return {
    ...target,
    chain: target.chain.toLowerCase(),
    token: normalizeTokenAddress(target.token),
  }
}

function responseCoin(
  coins: Record<string, DefiLlamaBatchCoin>,
  tokenKey: string,
): DefiLlamaBatchCoin | null {
  return Object.entries(coins).find(([key]) => key.toLowerCase() === tokenKey.toLowerCase())?.[1] ?? null
}

function selectBatchCoin(
  coin: DefiLlamaBatchCoin | null,
  requestedTimestamp: number,
  widthSeconds: number | null,
): DefiLlamaHistoricalCoin | null {
  const selected = coin?.prices
    .filter(point => Number.isSafeInteger(point.timestamp)
      && point.timestamp <= requestedTimestamp
      && (widthSeconds == null || Math.abs(requestedTimestamp - point.timestamp) <= widthSeconds))
    .sort((left, right) => right.timestamp - left.timestamp)[0]
  return selected
    ? {
        ...selected,
        ...(coin?.symbol ? { symbol: coin.symbol } : {}),
      }
    : null
}

function batchPayload(
  targets: RecursivePriceTarget[],
  widthSeconds: number | null,
  lookupKind: 'direct' | 'fallback',
): Record<string, number[]> {
  const payload = new Map<string, Set<number>>()
  for (const target of targets) {
    const identifier = lookupKind === 'direct'
      ? providerTokenKey(target)
      : eligibleAlias(target)?.identifier
    if (!identifier) continue

    const timestamps = payload.get(identifier) ?? new Set<number>()
    timestamps.add(target.requestedTimestamp)
    if (widthSeconds != null) {
      const nearWidth = Math.min(3_600, widthSeconds)
      timestamps.add(Math.max(target.requestedTimestamp - nearWidth, 0))
      timestamps.add(Math.max(target.requestedTimestamp - widthSeconds, 0))
    }
    payload.set(identifier, timestamps)
  }
  return Object.fromEntries(
    [...payload].map(([tokenKey, timestamps]) => [tokenKey, [...timestamps].sort((left, right) => left - right)]),
  )
}

function searchWidthSeconds(searchWidth: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(searchWidth)
  if (!match) return null
  const amount = Number(match[1])
  const unitSeconds = { s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] as 's' | 'm' | 'h' | 'd']
  const seconds = amount * unitSeconds
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

async function loadDefiLlamaCoin(
  defiLlama: Pick<DefiLlamaClient, 'getHistorical'>,
  tokenKey: string,
  timestamp: number,
  searchWidth: string,
) {
  const response = await defiLlama.getHistorical(timestamp, [tokenKey], searchWidth)
  return Object.entries(response.coins).find(
    ([key]) => key.toLowerCase() === tokenKey.toLowerCase(),
  )?.[1] ?? null
}

function invalidCoinError(coin: DefiLlamaHistoricalCoin): InvalidPricingError | null {
  if (!Number.isSafeInteger(coin.timestamp) || coin.timestamp < 0) {
    return new InvalidPricingError('DefiLlama returned an invalid observation timestamp')
  }
  if (!Number.isFinite(coin.price) || coin.price <= 0) {
    return new InvalidPricingError('DefiLlama returned a non-positive or non-finite price')
  }
  return null
}

function observationDirection(offsetSeconds: number): PriceObservationDirection {
  return offsetSeconds === 0 ? 'exact' : offsetSeconds < 0 ? 'before' : 'after'
}

function isStrictCandidate(candidate: PriceEvidenceCandidate): boolean {
  return candidate.validationStatus === 'validated'
    && candidate.classification === 'observed'
    && candidate.quality !== 'legacy'
    && candidate.failureReason === null
}

function candidateToPath(candidate: PriceEvidenceCandidate): ResolvedPricePath {
  if (candidate.classification === 'legacy' || candidate.quality === 'legacy') {
    throw new InvalidPricingError('Legacy evidence cannot seed strict recursive pricing')
  }
  return {
    chain: candidate.chain,
    token: candidate.token,
    requestedTimestamp: candidate.requestedTimestamp,
    observedTimestamp: candidate.observedTimestamp,
    priceUsd: candidate.priceUsd,
    symbol: candidate.symbol,
    confidence: candidate.confidence,
    source: candidate.source,
    adapter: candidate.adapter ?? 'persisted-evidence',
    classification: candidate.classification,
    quality: candidate.quality,
    blockNumber: candidate.blockNumber,
    inputs: candidate.inputs,
    metadata: candidate.metadata,
  }
}

function isProductionDailyImport(candidate: PriceEvidenceCandidate): boolean {
  return candidate.adapter === 'production-yearn-prices-import'
    && candidate.metadata.origin === 'production-yearn-prices'
    && candidate.metadata.importClassification === 'trusted-production-observation-structural'
    && candidate.metadata.independentlyValidated === false
    && candidate.validationStatus === 'validated'
    && candidate.classification === 'legacy'
    && candidate.quality === 'legacy'
    && candidate.source !== 'stable-peg'
    && candidate.observedTimestamp === candidate.requestedTimestamp
    && candidate.failureReason === null
}

function productionDailyImportToPath(candidate: PriceEvidenceCandidate): ResolvedPricePath {
  if (!isProductionDailyImport(candidate)) {
    throw new InvalidPricingError('Candidate is not an eligible production daily import')
  }
  return {
    chain: candidate.chain,
    token: candidate.token,
    requestedTimestamp: candidate.requestedTimestamp,
    observedTimestamp: candidate.observedTimestamp,
    priceUsd: candidate.priceUsd,
    symbol: candidate.symbol,
    confidence: candidate.confidence,
    source: candidate.source,
    adapter: candidate.adapter ?? 'production-yearn-prices-import',
    classification: 'estimated',
    quality: 'fallback',
    blockNumber: null,
    inputs: [],
    metadata: {
      ...candidate.metadata,
      adapterVersion: candidate.metadata.adapterVersion ?? HISTORICAL_MARKET_ADAPTER_VERSION,
      policyVersion: candidate.metadata.policyVersion ?? PRICE_SELECTION_POLICY_VERSION,
      recursiveSeedPolicy: 'explicit-production-eod-import',
      directObservationClaimed: false,
    },
  }
}

export function createHistoricalMarketPriceResolver(
  pool: Pool,
  options: HistoricalMarketResolverOptions = {},
  dependencies: HistoricalMarketResolverDependencies = {},
): HistoricalMarketPriceResolver {
  const defiLlama = dependencies.defiLlama ?? new DefiLlamaClient()
  const loadCandidates = dependencies.loadCandidates ?? getHistoricalPriceEvidenceCandidates
  const searchWidth = options.searchWidth ?? '6h'
  const widthSeconds = searchWidthSeconds(searchWidth)
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize')
  const batchConcurrency = positiveInteger(
    options.batchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
    'batchConcurrency',
  )
  const batchDelayMs = nonNegativeInteger(options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS, 'batchDelayMs')
  const providerCache = new Map<string, ProviderCacheEntry>()
  const unavailableAttempts = new Map<string, Array<{
    adapter: string
    reason: 'unsupported'
    error: string
  }>>()
  const pending = new Map<string, PendingProviderTarget>()
  let flushScheduled = false

  async function loadSingleIdentifierCoin(
    target: RecursivePriceTarget,
    identifier: string,
  ): Promise<DefiLlamaHistoricalCoin | null> {
    let coin = await loadDefiLlamaCoin(
      defiLlama,
      identifier,
      target.requestedTimestamp,
      searchWidth,
    )
    if (coin && coin.timestamp > target.requestedTimestamp) {
      const lookbacks = widthSeconds == null
        ? []
        : [...new Set([Math.min(3_600, widthSeconds), widthSeconds])]
      for (const lookback of lookbacks) {
        coin = await loadDefiLlamaCoin(
          defiLlama,
          identifier,
          Math.max(target.requestedTimestamp - lookback, 0),
          searchWidth,
        )
        if (!coin || coin.timestamp <= target.requestedTimestamp) break
      }
    }
    if (!coin || coin.timestamp > target.requestedTimestamp) return null
    if (widthSeconds != null && Math.abs(target.requestedTimestamp - coin.timestamp) > widthSeconds) return null
    return coin
  }

  async function loadSingleProviderResolution(target: RecursivePriceTarget): Promise<ProviderResolution | null> {
    let directError: InvalidPricingError | null = null
    const identifiers = providerIdentifiers(target)
    const direct = await loadSingleIdentifierCoin(target, identifiers[0])
    if (direct) {
      directError = invalidCoinError(direct)
      if (!directError) {
        return { coin: direct, matchedIdentifier: identifiers[0], lookupKind: 'direct', alias: null }
      }
    }

    const aliasIdentifier = identifiers[1]
    if (aliasIdentifier) {
      const alias = await loadSingleIdentifierCoin(target, aliasIdentifier)
      if (alias) {
        const aliasError = invalidCoinError(alias)
        if (!aliasError) {
          const configuredAlias = eligibleAlias(target)
          return {
            coin: alias,
            matchedIdentifier: aliasIdentifier,
            lookupKind: configuredAlias?.kind ?? 'coingecko-alias',
            alias: configuredAlias,
          }
        }
        if (!directError) directError = aliasError
      }
    }
    if (directError) throw directError
    return null
  }

  async function prefetch(targets: RecursivePriceTarget[]): Promise<void> {
    targets = targets.map(normalizeMarketTarget)
    const unique = [...new Map(
      targets.map(target => [providerTargetKey(target), target]),
    ).values()].filter(target => !providerCache.has(providerTargetKey(target)))
    if (unique.length === 0) return

    const batches = chunk(unique, batchSize)
    await mapConcurrent(batches, batchConcurrency, async batch => {
      if (!defiLlama.getBatchHistorical) {
        await Promise.all(batch.map(async target => {
          const key = providerTargetKey(target)
          try {
            providerCache.set(key, { resolution: await loadSingleProviderResolution(target), error: null })
          } catch (error) {
            providerCache.set(key, { resolution: null, error })
          }
        }))
        return
      }

      let directResponse
      try {
        directResponse = await defiLlama.getBatchHistorical(
          batchPayload(batch, widthSeconds, 'direct'),
          searchWidth,
        )
      } catch (error) {
        for (const target of batch) {
          providerCache.set(providerTargetKey(target), { resolution: null, error })
        }
        return
      }

      const aliasTargets: RecursivePriceTarget[] = []
      const invalidDirectErrors = new Map<string, InvalidPricingError>()
      for (const target of batch) {
        const key = providerTargetKey(target)
        const directIdentifier = providerTokenKey(target)
        const coin = selectBatchCoin(
          responseCoin(directResponse.coins, directIdentifier),
          target.requestedTimestamp,
          widthSeconds,
        )
        const invalidError = coin ? invalidCoinError(coin) : null
        if (coin && !invalidError) {
          providerCache.set(key, {
            resolution: {
              coin,
              matchedIdentifier: directIdentifier,
              lookupKind: 'direct',
              alias: null,
            },
            error: null,
          })
        } else if (eligibleAlias(target)) {
          aliasTargets.push(target)
          if (invalidError) invalidDirectErrors.set(key, invalidError)
        } else {
          providerCache.set(key, { resolution: null, error: invalidError })
        }
      }

      if (aliasTargets.length === 0) return
      let aliasResponse
      try {
        aliasResponse = await defiLlama.getBatchHistorical(
          batchPayload(aliasTargets, widthSeconds, 'fallback'),
          searchWidth,
        )
      } catch (error) {
        for (const target of aliasTargets) {
          providerCache.set(providerTargetKey(target), { resolution: null, error })
        }
        return
      }

      for (const target of aliasTargets) {
        const key = providerTargetKey(target)
        const configuredAlias = eligibleAlias(target)
        const aliasIdentifier = configuredAlias?.identifier
        if (!aliasIdentifier) continue
        const coin = selectBatchCoin(
          responseCoin(aliasResponse.coins, aliasIdentifier),
          target.requestedTimestamp,
          widthSeconds,
        )
        const aliasError = coin ? invalidCoinError(coin) : null
        providerCache.set(key, coin && !aliasError
          ? {
              resolution: {
                coin,
                matchedIdentifier: aliasIdentifier,
                lookupKind: configuredAlias.kind,
                alias: configuredAlias,
              },
              error: null,
            }
          : {
              resolution: null,
              error: aliasError ?? invalidDirectErrors.get(key) ?? null,
            })
      }
    })
  }

  async function flushPending(): Promise<void> {
    flushScheduled = false
    const batch = [...pending.values()]
    pending.clear()
    await prefetch(batch.map(item => item.target))
    for (const item of batch) {
      const entry = providerCache.get(providerTargetKey(item.target))
      if (entry?.error) {
        for (const waiter of item.waiters) waiter.reject(entry.error)
      } else {
        for (const waiter of item.waiters) waiter.resolve(entry?.resolution ?? null)
      }
    }
  }

  async function providerResolution(target: RecursivePriceTarget): Promise<ProviderResolution | null> {
    const key = providerTargetKey(target)
    const cached = providerCache.get(key)
    if (cached) {
      if (cached.error) throw cached.error
      return cached.resolution
    }
    if (!defiLlama.getBatchHistorical) return loadSingleProviderResolution(target)

    return new Promise((resolve, reject) => {
      const existing = pending.get(key)
      if (existing) existing.waiters.push({ resolve, reject })
      else pending.set(key, { target, waiters: [{ resolve, reject }] })
      if (!flushScheduled) {
        flushScheduled = true
        setTimeout(() => void flushPending(), batchDelayMs)
      }
    })
  }

  const resolver: HistoricalMarketPriceResolver = async requestedTarget => {
    const target = normalizeMarketTarget(requestedTarget)
    const candidates = await loadCandidates(pool, {
      chain: target.chain,
      token: target.token,
      timestamp: target.requestedTimestamp,
    })
    const strictSelection = selectEodPriceEvidence(
      target.requestedTimestamp,
      candidates.filter(isStrictCandidate),
      options,
    )
    if (strictSelection.validation.status === 'quarantined') {
      throw new DisagreementPricingError(
        strictSelection.validation.failureReason ?? 'Stored price evidence is quarantined for disagreement',
      )
    }
    const productionDailyImport = options.allowProductionDailyImport
      ? candidates.find(isProductionDailyImport) ?? null
      : null
    const persistedPath = strictSelection.selected
      ? candidateToPath(strictSelection.selected)
      : productionDailyImport
        ? productionDailyImportToPath(productionDailyImport)
        : null
    if (
      persistedPath
      && (widthSeconds == null
        || Math.abs(target.requestedTimestamp - persistedPath.observedTimestamp) <= widthSeconds)
    ) {
      return persistedPath
    }

    const provider = await providerResolution(target)
    if (!provider) {
      const configuredAlias = getDefiLlamaCoinGeckoAlias(target.chain, target.token)
      if (configuredAlias?.kind === 'canonical-market-proxy') {
        const interval = configuredAlias.validUntil != null
          && target.requestedTimestamp >= configuredAlias.validUntil
          ? `requested timestamp is at or after impairment boundary ${configuredAlias.validUntil}`
          : 'canonical provider returned no usable positive observation inside the search window'
        unavailableAttempts.set(providerTargetKey(target), [{
          adapter: 'defillama-canonical-market-proxy',
          reason: 'unsupported',
          error: `${configuredAlias.incident?.id ?? 'proxy policy'}: ${interval}`,
        }])
      }
      return persistedPath
    }

    const { coin, lookupKind, matchedIdentifier, alias } = provider
    const requestedIdentifier = providerTokenKey(target)
    const offsetSeconds = coin.timestamp - target.requestedTimestamp
    const isAlias = lookupKind !== 'direct'
    const isCanonicalProxy = lookupKind === 'canonical-market-proxy'

    return {
      chain: target.chain,
      token: target.token,
      requestedTimestamp: target.requestedTimestamp,
      observedTimestamp: coin.timestamp,
      priceUsd: coin.price,
      symbol: coin.symbol ?? null,
      confidence: coin.confidence ?? null,
      source: isCanonicalProxy
        ? 'defillama-canonical-market-proxy'
        : isAlias ? 'defillama-coingecko-alias' : 'defillama',
      adapter: isCanonicalProxy
        ? 'defillama-canonical-market-proxy'
        : isAlias ? 'defillama-coingecko-alias' : 'defillama-historical',
      classification: isAlias ? 'estimated' : 'observed',
      quality: isAlias ? 'fallback' : coin.timestamp === target.requestedTimestamp ? 'exact' : 'near-eod',
      blockNumber: null,
      inputs: [],
      metadata: {
        adapterVersion: HISTORICAL_MARKET_ADAPTER_VERSION,
        policyVersion: PRICE_SELECTION_POLICY_VERSION,
        provider: 'defillama',
        lookupKind,
        requestedIdentifier,
        matchedIdentifier,
        requestedTimestamp: target.requestedTimestamp,
        observedTimestamp: coin.timestamp,
        observationDistance: Math.abs(offsetSeconds),
        observationOffsetSeconds: offsetSeconds,
        observationDirection: observationDirection(offsetSeconds),
        selectionPolicy: 'latest-at-or-before-eod',
        searchWidth,
        ...(isAlias && alias
          ? {
              mapping: {
                kind: alias.kind,
                requestedIdentifier,
                providerIdentifier: matchedIdentifier,
                rationale: alias.rationale ?? null,
                assumption: alias.assumption ?? null,
                bridgeIssuer: alias.bridgeIssuer ?? null,
                validityInterval: {
                  validFrom: alias.validFrom ?? null,
                  validUntil: alias.validUntil ?? null,
                  validUntilInclusive: false,
                },
                references: alias.references ?? [],
              },
            }
          : {}),
        ...(isCanonicalProxy && alias
          ? {
              bridgeIssuer: alias.bridgeIssuer,
              validityInterval: {
                validFrom: alias.validFrom ?? null,
                validUntil: alias.validUntil ?? null,
                validUntilInclusive: false,
              },
              incident: alias.incident,
              assumption: alias.assumption,
              rationale: alias.rationale,
              references: alias.references,
            }
          : {}),
      },
    }
  }
  resolver.prefetch = prefetch
  resolver.unavailableAttempts = target => unavailableAttempts.get(providerTargetKey(normalizeMarketTarget(target))) ?? []
  return resolver
}
