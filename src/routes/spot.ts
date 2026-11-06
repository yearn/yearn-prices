import type { Pool } from '@neondatabase/serverless'
import { CACHE_CONTROL_NO_STORE, CACHE_CONTROL_SPOT } from '../cache'
import { ApiError, ensure, errorEnvelope, jsonResponse } from '../http'
import { writeDown } from '../prices/write-downs'
import { type SpotSourceRegistry, spotSourceRegistry } from '../registries'
import type { SpotPrice } from '../sources'
import type { Env, SpotRequest, SpotResponseCoin } from '../types'
import { chainNameToId, parseSpotCoins } from '../utils'
import { knownCurveLps, lpKey, MAX_GUARDED_RECORDS } from './historical/read-through'

const SPOT_RESOLUTION_DEADLINE_MS = 15_000

async function resolveWithSignal(
  registry: SpotSourceRegistry,
  chainId: number,
  token: string,
  signal: AbortSignal,
  guarded: boolean
): Promise<SpotPrice> {
  let rejectOnAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject
  })
  const onAbort = () => rejectOnAbort?.(new ApiError('UNAVAILABLE', 'Spot resolution deadline exceeded'))
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    onAbort()
  }

  try {
    if (signal.aborted) {
      return await aborted
    }
    return await Promise.race([registry.resolve(chainId, token, signal, guarded), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

// Stateless proxy for live spot prices from Enso. Intentionally does not persist:
// spot is a latest-price use case served by the edge cache, and writing a mid-day
// spot price as that day's historical close would corrupt the price history.
export async function handleSpot(
  request: Request,
  env: Env,
  registry: SpotSourceRegistry = spotSourceRegistry(env),
  pool?: Pool
): Promise<Response> {
  const requests = parseSpotCoins(new URL(request.url).searchParams.get('coins'))
  const controller = new AbortController()
  const cancelFromRequest = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) {
    cancelFromRequest()
  } else {
    request.signal.addEventListener('abort', cancelFromRequest, { once: true })
  }

  const timeout = setTimeout(() => controller.abort(), SPOT_RESOLUTION_DEADLINE_MS)
  let settled: PromiseSettledResult<{ req: SpotRequest; spot: SpotPrice }>[]
  try {
    const quotes = new Map<string, SpotPrice>()
    for (const req of requests) {
      const chainId = chainNameToId(req.chain)
      void (chainId === undefined ? Promise.resolve(undefined) :
        registry.resolve(chainId, req.token.toLowerCase(), controller.signal, false)
          .then((price) => { quotes.set(req.originalKey, price); return price })
          .catch(() => undefined))
    }
    const empty = new Set<string>()
    let stopLookup: (() => void) | undefined
    const stopped = new Promise<Set<string>>((resolve) => {
      stopLookup = () => resolve(empty)
      controller.signal.addEventListener('abort', stopLookup, { once: true })
      if (controller.signal.aborted) stopLookup()
    })
    const lps = await Promise.race([
      pool ? knownCurveLps(pool, requests).catch(() => empty) : Promise.resolve(empty),
      stopped
    ])
    if (stopLookup) controller.signal.removeEventListener('abort', stopLookup)
    let guardedCount = 0
    settled = await Promise.allSettled(
      requests.map(async (req): Promise<{ req: SpotRequest; spot: SpotPrice }> => {
        const chainId = chainNameToId(req.chain)
        ensure(chainId !== undefined, 'INVALID_INPUT', `Unsupported chain: ${req.chain}`)

        const guarded = lps.has(lpKey(req.chain, req.token)) && guardedCount++ < MAX_GUARDED_RECORDS
        const cached = quotes.get(req.originalKey)
        const spot =
          writeDown(chainId, req.token, Math.floor(Date.now() / 1000)) ??
          (!guarded && cached ? cached : await resolveWithSignal(
            registry,
            chainId,
            req.token.toLowerCase(),
            controller.signal,
            guarded
          ))

        return {
          req,
          spot
        }
      })
    )
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', cancelFromRequest)
  }

  const coins: Record<string, SpotResponseCoin> = {}
  let hasRetryableFailure = false

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      const tokenKey = requests[i].originalKey
      const reason = outcome.reason
      console.error(
        JSON.stringify({
          message: 'spot-error',
          token_key: tokenKey,
          error: reason instanceof Error ? reason.message : String(reason)
        })
      )
      // Same envelope as jsonError: { error: { code, message } }.
      // NOT_FOUND = no price (permanent); anything else is retryable.
      coins[tokenKey] =
        reason instanceof ApiError && reason.code === 'NOT_FOUND'
          ? errorEnvelope('NOT_FOUND', 'No price available for this token')
          : errorEnvelope('UNAVAILABLE', 'Price temporarily unavailable, please retry')
      if (!(reason instanceof ApiError && reason.code === 'NOT_FOUND')) {
        hasRetryableFailure = true
      }
      continue
    }

    const { req, spot } = outcome.value
    coins[req.originalKey] = {
      symbol: spot.symbol,
      prices: [
        {
          timestamp: spot.timestamp,
          price: spot.price,
          confidence: spot.confidence,
          source: spot.source
        }
      ]
    }
  }

  return jsonResponse(
    { coins },
    {
      headers: {
        'cache-control': hasRetryableFailure ? CACHE_CONTROL_NO_STORE : CACHE_CONTROL_SPOT
      }
    }
  )
}
