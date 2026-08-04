import { ApiError } from './errors'
import type { Env } from './types'

export interface AuthenticatedClient {
  clientId: string
  access: 'read' | 'operator'
}

export function authenticateRequest(request: Request, env: Env): AuthenticatedClient {
  const presentedKey = getPresentedApiKey(request)
  if (!presentedKey) {
    throw new ApiError('UNAUTHORIZED', 'Missing API key')
  }

  if (env.DAILY_PRICE_OPERATOR_API_KEY && env.DAILY_PRICE_OPERATOR_API_KEY === presentedKey) {
    return { clientId: 'daily-price-operator', access: 'operator' }
  }

  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith('API_KEY_') || !envValue) {
      continue
    }

    if (envValue === presentedKey) {
      return { clientId: envKey.slice('API_KEY_'.length).toLowerCase(), access: 'read' }
    }
  }

  throw new ApiError('UNAUTHORIZED', 'Invalid API key')
}

export function requireDailyPriceOperator(client: AuthenticatedClient): void {
  if (client.access !== 'operator') {
    throw new ApiError('FORBIDDEN', 'Daily price queue mutations require an operator API key')
  }
}

function getPresentedApiKey(request: Request): string | null {
  const bearerHeader = request.headers.get('authorization')
  if (bearerHeader?.startsWith('Bearer ')) {
    return bearerHeader.slice('Bearer '.length).trim()
  }

  return request.headers.get('x-api-key')
}
