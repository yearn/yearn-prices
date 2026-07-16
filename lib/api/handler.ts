import type { Pool } from '@neondatabase/serverless'
import { authenticateRequest } from '@/lib/api/auth'
import { readEdgeCache, writeEdgeCache } from '@/lib/api/edge-cache'
import { getRuntimeContext } from '@/lib/api/env'
import { ApiError, jsonError } from '@/lib/api/errors'
import { optionsResponse, withCors } from '@/lib/api/http'
import { createPool } from '@/lib/db'
import { CACHE_CONTROL_NO_STORE } from '@/lib/prices/cache'
import { notFoundErrorHeaders } from '@/lib/prices/historical'
import type { Env } from '@/lib/prices/types'

export interface ApiHandlerContext {
  env: Env
  pool: Pool | null
  clientId: string | null
}

export interface ApiHandlerOptions {
  /** Require API key auth. Default true. */
  auth?: boolean
  /** Open a Neon pool for the request duration. Default false. */
  db?: boolean
  /**
   * When true, NOT_FOUND responses get the historical negative-cache headers
   * instead of no-store.
   */
  notFoundCacheable?: boolean
  /**
   * When true (default), successful GETs are served from / written to
   * Cloudflare's edge Cache API (`caches.default`).
   */
  edgeCache?: boolean
}

function logRequest(request: Request, clientId: string | null, extra?: Record<string, unknown>): void {
  console.info(
    JSON.stringify({
      message: 'request',
      method: request.method,
      path: new URL(request.url).pathname,
      client_id: clientId,
      ...extra,
    }),
  )
}

export function handleOptions(): Response {
  return optionsResponse()
}

export async function withApiHandler(
  request: Request,
  options: ApiHandlerOptions,
  handler: (ctx: ApiHandlerContext) => Promise<Response>,
): Promise<Response> {
  const { env, waitUntil } = await getRuntimeContext()
  const requireAuth = options.auth !== false
  const needsDb = options.db === true
  const useEdgeCache = options.edgeCache !== false
  let clientId: string | null = null
  let pool: Pool | null = null

  try {
    if (requireAuth) {
      ;({ clientId } = authenticateRequest(request, env))
    }
    logRequest(request, clientId)

    // Auth first (same as the old Worker), then edge cache before any Enso/DB work.
    if (useEdgeCache && request.method === 'GET') {
      const cached = await readEdgeCache(request)
      if (cached) {
        return cached
      }
    }

    if (needsDb) {
      if (!env.DATABASE_URL) {
        throw new ApiError('INTERNAL_ERROR', 'DATABASE_URL is not configured')
      }
      pool = createPool(env.DATABASE_URL)
    }

    const response = await handler({ env, pool, clientId })

    // Only successful GETs populate the edge (errors return from catch and stay out).
    if (useEdgeCache && request.method === 'GET' && response.ok) {
      writeEdgeCache(request, response, waitUntil)
    }

    return response
  } catch (error) {
    const pathname = new URL(request.url).pathname

    if (error instanceof ApiError) {
      console.error(
        JSON.stringify({
          message: 'request-error',
          path: pathname,
          client_id: clientId,
          code: error.code,
          status: error.status,
          detail: error.message,
        }),
      )
      const headers =
        error.code === 'NOT_FOUND' && options.notFoundCacheable
          ? withCors(notFoundErrorHeaders())
          : withCors({ 'cache-control': CACHE_CONTROL_NO_STORE })
      return jsonError(error, headers)
    }

    console.error(
      JSON.stringify({
        message: 'request-error',
        path: pathname,
        client_id: clientId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return jsonError(
      new ApiError('INTERNAL_ERROR', 'Unexpected internal error'),
      withCors({ 'cache-control': CACHE_CONTROL_NO_STORE }),
    )
  } finally {
    if (pool) {
      await pool.end()
    }
  }
}
