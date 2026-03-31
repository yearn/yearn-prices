import { ApiError } from './errors'
import type { Env } from './types'

export interface AuthenticatedClient {
  clientId: string
}

export function authenticateRequest(request: Request, env: Env): AuthenticatedClient {
  const presentedKey = getPresentedApiKey(request)
  if (!presentedKey) {
    throw new ApiError('UNAUTHORIZED', 'Missing API key')
  }

  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey.startsWith('API_KEY_') || !envValue) {
      continue
    }

    if (envValue === presentedKey) {
      return { clientId: envKey.slice('API_KEY_'.length).toLowerCase() }
    }
  }

  throw new ApiError('UNAUTHORIZED', 'Invalid API key')
}

function getPresentedApiKey(request: Request): string | null {
  const bearerHeader = request.headers.get('authorization')
  if (bearerHeader?.startsWith('Bearer ')) {
    return bearerHeader.slice('Bearer '.length).trim()
  }

  return request.headers.get('x-api-key')
}
