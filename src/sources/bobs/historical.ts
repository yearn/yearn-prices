import type { PublicClient } from 'viem'
import { parseRetryAfter, SharedCooldownRateLimiter } from '../../clients/http-client'
import { estimateBlockByTimestamp, getChainClient } from '../../clients/rpc'
import { ApiError } from '../../http/errors'
import type { Env } from '../../types'
import { HistoricalPriceSourceBase } from '../base'
import type { HistoricalPriceResult } from '../types'

/** The public beta endpoint used by ypricemagic when configured. */
export const DEFAULT_BOBS_API_URL = 'https://ypriceapi-beta.yearn.finance'

/** A historical observation must be no more than six hours before its target. */
export const BOBS_MAX_OBSERVATION_AGE_SECONDS = 6 * 60 * 60

const CHAINS_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_PRICE_CACHE_ENTRIES = 512
const DEFAULT_TIMEOUT_MS = 5_000

/** Keep the gate shared by source instances that use the same credentials. */
const providerGates = new Map<string, SharedCooldownRateLimiter>()

function runtimeEnv(name: string, env?: Env): string | undefined {
  // An explicit Worker environment is authoritative. Falling back to
  // process.env for a missing optional key can accidentally enable this
  // credentialed source from a Node-compatible process shim.
  if (env) return env[name]
  if (typeof process !== 'undefined') return process.env[name]
  return undefined
}

export type BobsClientForChain = (chainId: number) => PublicClient | null

export interface BobsHistoricalSourceOptions {
  env?: Env
  clientForChain?: BobsClientForChain
  /** Override the endpoint for an operator-owned compatible deployment. HTTPS only. */
  baseUrl?: string
  signer?: string
  signature?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
  /** Tests and callers that intentionally share a custom provider gate. */
  rateLimiter?: SharedCooldownRateLimiter
}

type CachedChains = {
  expiresAt: number
  chains: ReadonlySet<number>
}

type CachedPrice = HistoricalPriceResult

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > maxSize) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function credentialKey(baseUrl: string, signer: string, signature: string): string {
  return `${baseUrl}\u0000${signer}\u0000${signature}`
}

function gateFor(key: string): SharedCooldownRateLimiter {
  const existing = providerGates.get(key)
  if (existing) return existing
  // A rate-limited provider is skipped by the resolver until its cooldown
  // expires; waiting for hours would consume the historical route budget.
  const gate = new SharedCooldownRateLimiter(10, 1_000, 0)
  providerGates.set(key, gate)
  return gate
}

function unavailable(message: string): ApiError {
  return new ApiError('UNAVAILABLE', message)
}

function parseChains(payload: unknown): ReadonlySet<number> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw unavailable('Bobs API returned a malformed chain map')
  }

  const chains = new Set<number>()
  for (const [rawId, name] of Object.entries(payload as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(rawId) || typeof name !== 'string' || name.trim() === '') {
      throw unavailable('Bobs API returned a malformed chain map')
    }
    const chainId = Number(rawId)
    if (!Number.isSafeInteger(chainId)) {
      throw unavailable('Bobs API returned a malformed chain map')
    }
    chains.add(chainId)
  }
  return chains
}

function parsePrice(payload: unknown): number | null {
  if (payload === null) return null

  let value: number
  if (typeof payload === 'number') {
    value = payload
  } else if (typeof payload === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(payload.trim())) {
    value = Number(payload)
  } else {
    throw unavailable('Bobs API returned a malformed price')
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw unavailable('Bobs API returned a non-positive price')
  }
  return value
}

function blockTimestamp(block: Awaited<ReturnType<PublicClient['getBlock']>>): number | null {
  const timestamp = Number(block.timestamp)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

/**
 * Optional historical source backed by BobTheBuidler's ypriceAPI contract.
 *
 * The API prices a token at a block. We therefore resolve the requested
 * timestamp to the last block at or before it, read that block again, and use
 * the block timestamp as the observation timestamp. Provider misses are null;
 * malformed/transient responses remain retryable UNAVAILABLE errors.
 */
export class BobsHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = 'bobs-api'
  readonly priority = 17

  private readonly baseUrl: string | null
  private readonly signer: string | null
  private readonly signature: string | null
  private readonly credentialKey: string | null
  private readonly clientForChain: BobsClientForChain
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly gate: SharedCooldownRateLimiter
  private chainsCache: CachedChains | null = null
  private chainsInflight: Promise<ReadonlySet<number>> | null = null
  private readonly priceCache = new Map<string, CachedPrice>()
  private readonly priceInflight = new Map<string, Promise<HistoricalPriceResult | null>>()

  constructor(options: BobsHistoricalSourceOptions = {}) {
    super()

    const rawBaseUrl = options.baseUrl ?? runtimeEnv('YPRICEAPI_URL', options.env) ?? DEFAULT_BOBS_API_URL
    let parsedBaseUrl: URL
    try {
      parsedBaseUrl = new URL(rawBaseUrl)
    } catch {
      throw new Error('YPRICEAPI_URL must be a valid HTTPS URL')
    }
    if (
      parsedBaseUrl.protocol !== 'https:' ||
      parsedBaseUrl.username !== '' ||
      parsedBaseUrl.password !== '' ||
      parsedBaseUrl.search !== '' ||
      parsedBaseUrl.hash !== ''
    ) {
      throw new Error('YPRICEAPI_URL must use HTTPS')
    }
    const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '')
    this.baseUrl = baseUrl

    const signer = (options.signer ?? runtimeEnv('YPRICEAPI_SIGNER', options.env))?.trim()
    const signature = (options.signature ?? runtimeEnv('YPRICEAPI_SIGNATURE', options.env))?.trim()
    this.signer = signer || null
    this.signature = signature || null
    this.credentialKey = this.signer && this.signature ? credentialKey(baseUrl, this.signer, this.signature) : null
    this.gate =
      options.rateLimiter ??
      (this.credentialKey ? gateFor(this.credentialKey) : new SharedCooldownRateLimiter(10, 1_000))
    this.clientForChain = options.clientForChain ?? ((chainId) => getChainClient(chainId, options.env))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
  }

  supports(chainId: number): boolean {
    if (!this.credentialKey || !Number.isSafeInteger(chainId) || chainId <= 0) return false
    return this.clientForChain(chainId) !== null
  }

  async getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    if (typeof token !== 'string') return null
    const normalizedToken = token.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(normalizedToken)) return null
    if (!this.supports(chainId) || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null

    const chains = await this.getChains()
    if (!chains.has(chainId)) return null

    const client = this.clientForChain(chainId)
    if (!client) return null

    const block = await this.resolveBlock(client, chainId, timestamp)
    if (!block) return null

    const key = `${chainId}:${normalizedToken}:${block.number.toString()}`
    const cached = this.priceCache.get(key)
    if (cached) {
      cappedSet(this.priceCache, key, cached, MAX_PRICE_CACHE_ENTRIES)
      return cached
    }

    const existing = this.priceInflight.get(key)
    if (existing) return existing

    const request = this.requestPrice(chainId, normalizedToken, block.number, block.timestamp)
      .then((price) => {
        if (price) cappedSet(this.priceCache, key, price, MAX_PRICE_CACHE_ENTRIES)
        return price
      })
      .finally(() => {
        if (this.priceInflight.get(key) === request) this.priceInflight.delete(key)
      })

    this.priceInflight.set(key, request)
    return request
  }

  private async getChains(): Promise<ReadonlySet<number>> {
    const now = this.now()
    if (this.chainsCache && this.chainsCache.expiresAt > now) return this.chainsCache.chains
    if (this.chainsInflight) return this.chainsInflight

    const request = this.requestJson('/chains', false)
      .then((payload) => {
        const chains = parseChains(payload)
        this.chainsCache = { chains, expiresAt: this.now() + CHAINS_CACHE_TTL_MS }
        return chains
      })
      .finally(() => {
        this.chainsInflight = null
      })

    this.chainsInflight = request
    return request
  }

  private async resolveBlock(
    client: PublicClient,
    chainId: number,
    timestamp: number
  ): Promise<{ number: bigint; timestamp: number } | null> {
    let number: bigint
    let block: Awaited<ReturnType<PublicClient['getBlock']>>
    try {
      number = await estimateBlockByTimestamp(client, chainId, timestamp)
      block = await client.getBlock({ blockNumber: number })
    } catch {
      throw unavailable(`Bobs API block lookup failed on chain ${chainId}`)
    }

    const observed = blockTimestamp(block)
    if (observed === null || observed > timestamp || timestamp - observed > BOBS_MAX_OBSERVATION_AGE_SECONDS) {
      return null
    }
    return { number: block.number ?? number, timestamp: observed }
  }

  private async requestPrice(
    chainId: number,
    token: string,
    block: bigint,
    timestamp: number
  ): Promise<HistoricalPriceResult | null> {
    const payload = await this.requestJson(`/get_price/${chainId}/${encodeURIComponent(token)}?block=${block}`, true)
    const price = parsePrice(payload)
    if (price === null) return null
    const blockNumber = Number(block)
    if (!Number.isSafeInteger(blockNumber)) throw unavailable('Bobs API returned an unsafe block number')
    return {
      price,
      // The provider answer is pinned to this block, so expose the block's
      // observed time rather than the caller's target time. The target is
      // retained by the resolver separately for provenance.
      timestamp,
      symbol: null,
      confidence: null,
      evidence: {
        blockNumber,
        blockTimestamp: timestamp,
        observationEndpoint: '/get_price'
      }
    }
  }

  private async requestJson(path: string, allowNotFound: boolean): Promise<unknown | null> {
    if (!this.signer || !this.signature || !this.baseUrl) return null

    await this.gate.waitTurn()
    let response: Response
    try {
      const signal = this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'X-Signer': this.signer,
          'X-Signature': this.signature
        },
        ...(signal ? { signal } : {})
      })
    } catch {
      throw unavailable('Bobs API request failed')
    }

    if (response.status === 404 && allowNotFound) {
      void response.body?.cancel().catch(() => undefined)
      return null
    }

    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after') ?? null, Number.MAX_SAFE_INTEGER)
      this.gate.extendCooldown(retryAfter ?? 60_000)
      void response.body?.cancel().catch(() => undefined)
      throw unavailable(`Bobs API returned status ${response.status}`)
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw unavailable(`Bobs API returned status ${response.status}`)
    }

    try {
      return await response.json()
    } catch {
      throw unavailable('Bobs API returned malformed JSON')
    }
  }
}

export function createBobsHistoricalSource(options: BobsHistoricalSourceOptions = {}): BobsHistoricalSource {
  return new BobsHistoricalSource(options)
}

/** Returns the optional source only when both ypriceAPI credentials are present. */
export function createOptionalBobsHistoricalSource(env?: Env): BobsHistoricalSource | null {
  const signer = runtimeEnv('YPRICEAPI_SIGNER', env)
  const signature = runtimeEnv('YPRICEAPI_SIGNATURE', env)
  if (!signer || !signature) return null
  return createBobsHistoricalSource({ env, signer, signature })
}
