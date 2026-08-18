import { CACHE_CONTROL_SPOT } from '../cache'
import { ApiError, ensure, errorEnvelope, jsonResponse } from '../http'
import { spotSourceRegistry, SpotSourceRegistry } from '../registries'
import type { SpotPrice } from '../sources'
import type { Env, SpotRequest, SpotResponseCoin } from '../types'
import { chainNameToId, parseSpotCoins } from '../utils'

// Stateless proxy for live spot prices from Enso. Intentionally does not persist:
// spot is a latest-price use case served by the edge cache, and writing a mid-day
// spot price as that day's historical close would corrupt the price history.
export async function handleSpot(
  request: Request,
  env: Env,
  registry: SpotSourceRegistry = spotSourceRegistry(env),
): Promise<Response> {
  const requests = parseSpotCoins(new URL(request.url).searchParams.get('coins'))

  const settled = await Promise.allSettled(
    requests.map(async (req): Promise<{ req: SpotRequest; spot: SpotPrice }> => {
      const chainId = chainNameToId(req.chain)
      ensure(chainId !== undefined, 'INVALID_INPUT', `Unsupported chain: ${req.chain}`)

      const spot = await registry.resolve(chainId, req.token.toLowerCase())

      return {
        req,
        spot,
      }
    }),
  )

  const coins: Record<string, SpotResponseCoin> = {}

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      const tokenKey = requests[i].originalKey
      const reason = outcome.reason
      console.error(
        JSON.stringify({
          message: 'spot-error',
          token_key: tokenKey,
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      // Same envelope as jsonError: { error: { code, message } }.
      // NOT_FOUND = no price (permanent); anything else is retryable.
      coins[tokenKey] =
        reason instanceof ApiError && reason.code === 'NOT_FOUND'
          ? errorEnvelope('NOT_FOUND', 'No price available for this token')
          : errorEnvelope('UNAVAILABLE', 'Price temporarily unavailable, please retry')
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
          source: spot.source,
        },
      ],
    }
  }

  return jsonResponse(
    { coins },
    {
      headers: {
        'cache-control': CACHE_CONTROL_SPOT,
      },
    },
  )
}
