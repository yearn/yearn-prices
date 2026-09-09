import { CACHE_CONTROL_NO_STORE, CACHE_CONTROL_SPOT } from '../cache'
import { ApiError, ensure, errorEnvelope, jsonResponse } from '../http'
import { type SpotSourceRegistry, spotSourceRegistry } from '../registries'
import type { SpotPrice } from '../sources'
import type { Env, SpotRequest, SpotResponseCoin } from '../types'
import { chainNameToId, parseSpotCoins } from '../utils'

// Upper bound on the whole batch. Per-call timeouts plus retry backoff can still add
// up, so completed tokens are returned once this elapses and the stragglers report
// UNAVAILABLE rather than holding the response open.
const BATCH_DEADLINE_MS = 12_000

// Stateless proxy for live spot prices from Enso. Intentionally does not persist:
// spot is a latest-price use case served by the edge cache, and writing a mid-day
// spot price as that day's historical close would corrupt the price history.
export async function handleSpot(
  request: Request,
  env: Env,
  registry: SpotSourceRegistry = spotSourceRegistry(env)
): Promise<Response> {
  const requests = parseSpotCoins(new URL(request.url).searchParams.get('coins'))

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new ApiError('UNAVAILABLE', 'Upstream price lookup exceeded the request deadline')),
      BATCH_DEADLINE_MS
    )
  })

  const resolveSpot = async (req: SpotRequest): Promise<{ req: SpotRequest; spot: SpotPrice }> => {
    const chainId = chainNameToId(req.chain)
    ensure(chainId !== undefined, 'INVALID_INPUT', `Unsupported chain: ${req.chain}`)

    const spot = await registry.resolve(chainId, req.token.toLowerCase())

    return {
      req,
      spot
    }
  }

  const settled = await Promise.allSettled(requests.map((req) => Promise.race([resolveSpot(req), deadline])))
  clearTimeout(deadlineTimer)

  const coins: Record<string, SpotResponseCoin> = {}
  let hasTransientFailure = false

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
      if (reason instanceof ApiError && reason.code === 'NOT_FOUND') {
        coins[tokenKey] = errorEnvelope('NOT_FOUND', 'No price available for this token')
        continue
      }

      // A transient failure must not be cached as a successful response: the outage would
      // outlive the provider's recovery for the whole shared-cache TTL.
      hasTransientFailure = true
      coins[tokenKey] = errorEnvelope('UNAVAILABLE', 'Price temporarily unavailable, please retry')
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
        'cache-control': hasTransientFailure ? CACHE_CONTROL_NO_STORE : CACHE_CONTROL_SPOT
      }
    }
  )
}
