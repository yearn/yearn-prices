import { ApiError } from '../../http/errors'
import { createMarketPriceResolver } from '../../registries/market-price'
import { SpotSourceRegistry } from '../../registries/spot'
import { chainIdToName } from '../../utils/chains'
import { nowUnix } from '../../utils/time'
import { createChainlinkHistoricalSource } from '../chainlink'
import { createDefiLlamaSpotSource } from '../defillama'
import { createEnsoSpotSource } from '../enso'
import type { SpotPriceResult, SpotPriceSource } from '../types'
import type { Env, PriceSource } from '../../types'
import { createOnchainSpotSource } from './source'

export interface CurrentFallbackQuote {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
  source: PriceSource
  observationEndpoint: string
}

export interface CurrentFallbackResult {
  prices: Map<string, CurrentFallbackQuote>
  failed: boolean
}

export interface CurrentFallbackTarget {
  chainId: number
  chain: string
  token: string
}

const FALLBACK_TIMEOUT_MS = 2_500

function key(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

function withDeadline<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ApiError('UNAVAILABLE', 'Current fallback deadline exceeded'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new ApiError('UNAVAILABLE', 'Current fallback deadline exceeded'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let promise: Promise<T>
    try {
      promise = start()
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      reject(error)
      return
    }
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

class CachedDefiLlamaSource implements SpotPriceSource {
  readonly name = 'defillama'
  readonly priority = 15

  constructor(
    private readonly cached: Map<
      string,
      { price: number; timestamp: number; symbol: string | null; confidence: number | null }
    >,
    private readonly knownMissing: Set<string>,
    private readonly delegate: SpotPriceSource
  ) {}

  supports(chainId: number): boolean {
    return this.delegate.supports(chainId)
  }

  async getSpotPrice(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPriceResult | null> {
    signal?.throwIfAborted()
    const chain = chainIdToName(chainId)
    if (!chain) return null
    const item = this.cached.get(key(chain, token))
    if (item) return { ...item }
    if (this.knownMissing.has(key(chain, token))) return null
    return this.delegate.getSpotPrice(chainId, token, signal)
  }
}

class ChainlinkCurrentSource implements SpotPriceSource {
  readonly name = 'chainlink'
  readonly priority = 14

  constructor(private readonly source: ReturnType<typeof createChainlinkHistoricalSource>) {}

  supports(chainId: number): boolean {
    return this.source.supports(chainId)
  }

  async getSpotPrice(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPriceResult | null> {
    const result = signal
      ? await withDeadline(() => this.source.getHistoricalPrice(chainId, token, nowUnix()), signal)
      : await this.source.getHistoricalPrice(chainId, token, nowUnix())
    return result
  }
}

/** Resolves today's current misses with Chainlink, derived pricing, and an optional Enso fallback. */
export async function resolveCurrentFallback(
  env: Env,
  targets: CurrentFallbackTarget[],
  cached: Map<string, { price: number; timestamp: number; symbol: string | null; confidence: number | null }>,
  signal?: AbortSignal
): Promise<CurrentFallbackResult> {
  if (targets.length === 0) return { prices: new Map(), failed: false }

  const timeout = AbortSignal.timeout(FALLBACK_TIMEOUT_MS)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  const defiLlama = createDefiLlamaSpotSource()
  const chainlink = createChainlinkHistoricalSource({ env })
  const enso = env.ENSO_API_KEY ? createEnsoSpotSource(env.ENSO_API_KEY) : undefined
  const knownMissing = new Set(targets.map((target) => key(target.chain, target.token)))
  const marketSources: SpotPriceSource[] = [
    new ChainlinkCurrentSource(chainlink),
    new CachedDefiLlamaSource(cached, knownMissing, defiLlama)
  ]
  if (enso) marketSources.push(enso)
  const marketRegistry = new SpotSourceRegistry(marketSources)
  const marketPrice = createMarketPriceResolver(marketSources, (chainId, token, _timestamp, signal) =>
    marketRegistry.resolve(chainId, token, signal)
  )
  const derived = createOnchainSpotSource({ env, marketPrice })
  const prices = new Map<string, CurrentFallbackQuote>()
  let failed = false

  await Promise.all(
    targets.map(async (target) => {
      const targetKey = key(target.chain, target.token)
      try {
        const chainlinkPrice = await withDeadline(
          () => chainlink.getHistoricalPrice(target.chainId, target.token, nowUnix()),
          deadline
        )
        if (chainlinkPrice) {
          prices.set(targetKey, {
            ...chainlinkPrice,
            source: 'chainlink',
            observationEndpoint: 'onchain.chainlink.latestRoundData'
          })
          return
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) failed = true
      }

      try {
        const derivedPrice = await withDeadline(
          () => derived.getSpotPrice(target.chainId, target.token, deadline),
          deadline
        )
        if (derivedPrice) {
          prices.set(targetKey, {
            ...derivedPrice,
            source: 'derived',
            observationEndpoint: 'onchain.derived'
          })
          return
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) failed = true
      }

      if (!enso) return
      try {
        const ensoPrice = await withDeadline(
          () => enso.getSpotPrice(target.chainId, target.token, deadline),
          deadline
        )
        if (ensoPrice) {
          prices.set(targetKey, { ...ensoPrice, source: 'enso', observationEndpoint: 'enso.current' })
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NOT_FOUND')) failed = true
      }
    })
  )

  return { prices, failed }
}
