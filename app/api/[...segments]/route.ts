import { handleOptions } from '@/lib/api/handler'
import { ApiError, jsonError } from '@/lib/api/errors'
import { withCors } from '@/lib/api/http'
import { CACHE_CONTROL_NO_STORE } from '@/lib/prices/cache'

export const dynamic = 'force-dynamic'

function routeNotFound(): Response {
  return jsonError(
    new ApiError('NOT_FOUND', 'Route not found'),
    withCors({ 'cache-control': CACHE_CONTROL_NO_STORE }),
  )
}

export const GET = routeNotFound
export const HEAD = routeNotFound
export const POST = routeNotFound
export const PUT = routeNotFound
export const PATCH = routeNotFound
export const DELETE = routeNotFound

export function OPTIONS(): Response {
  return handleOptions()
}
