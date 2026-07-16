import { chainNameToId } from '@/lib/chains'
import { ensure } from '@/lib/api/errors'
import { jsonResponse } from '@/lib/api/http'
import { EnsoClient } from '@/lib/providers/enso'
import { CACHE_CONTROL_SPOT } from '@/lib/prices/cache'
import type { BatchHistoricalResponseCoin, Env, SpotRequest } from '@/lib/prices/types'
import { parseSpotCoins } from '@/lib/prices/validation'
import { nowUnix, toUnixSeconds } from '@/lib/time'

// Stateless proxy for live spot prices from Enso. Intentionally does not persist:
// writing a mid-day spot price as that day's historical close would corrupt history.
export async function handleSpot(request: Request, env: Env): Promise<Response> {
  ensure(env.ENSO_API_KEY, 'INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  const requests = parseSpotCoins(new URL(request.url).searchParams.get('coins'))

  const enso = new EnsoClient(env.ENSO_API_KEY)
  const settled = await Promise.allSettled(
    requests.map(async (req): Promise<{
      req: SpotRequest
      timestamp: number
      symbol: string | null
      price: number
      confidence: number | null
    }> => {
      const chainId = chainNameToId(req.chain)
      ensure(chainId !== undefined, 'INVALID_INPUT', `Unsupported chain: ${req.chain}`)

      const priceData = await enso.getPrice(chainId, req.token.toLowerCase())
      ensure(
        typeof priceData.price === 'number' && Number.isFinite(priceData.price) && priceData.price > 0,
        'NOT_FOUND',
        `Enso returned no valid price for ${req.originalKey}`,
      )

      const timestamp =
        typeof priceData.timestamp === 'number' && Number.isFinite(priceData.timestamp) && priceData.timestamp > 0
          ? toUnixSeconds(priceData.timestamp)
          : nowUnix()

      return {
        req,
        timestamp,
        symbol: priceData.symbol ?? null,
        price: priceData.price,
        confidence: priceData.confidence ?? null,
      }
    }),
  )

  const coins: Record<string, BatchHistoricalResponseCoin> = {}

  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i]
    if (outcome.status === 'rejected') {
      console.error(
        JSON.stringify({
          message: 'enso-spot-error',
          token_key: requests[i].originalKey,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        }),
      )
      continue
    }

    const { req, timestamp, symbol, price, confidence } = outcome.value
    coins[req.originalKey] = {
      symbol,
      prices: [{ timestamp, price, confidence, source: 'enso' }],
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
