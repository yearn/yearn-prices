import { authenticateRequest } from './auth'
import { createPool } from './db'
import { readEdgeCache, writeEdgeCache } from './edge-cache'
import { ApiError, jsonError } from './errors'
import { optionsResponse, withCors } from './http'
import { handleHealth } from './routes/health'
import { handleBatchHistorical, handleHistorical, handleRangeHistorical, handleSpot, notFoundErrorHeaders } from './routes/prices'
import type { Env } from './types'

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

async function routePriceRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  // Spot is a stateless Enso proxy — no database connection needed.
  if (pathname === '/api/prices/spot' && request.method === 'GET') {
    return handleSpot(request, env)
  }

  if (!env.DATABASE_URL) {
    throw new ApiError('INTERNAL_ERROR', 'DATABASE_URL is not configured')
  }

  const pool = createPool(env.DATABASE_URL)
  try {
    if (pathname === '/api/prices/batchHistorical' && request.method === 'GET') {
      return await handleBatchHistorical(request, env, pool)
    }

    if (pathname === '/api/prices/rangeHistorical' && request.method === 'GET') {
      return await handleRangeHistorical(request, env, pool)
    }

    const historicalMatch = pathname.match(/^\/api\/prices\/historical\/([^/]+)\/([^/]+)$/)
    if (historicalMatch && request.method === 'GET') {
      const [, timestampSegment, tokenKeySegment] = historicalMatch
      return await handleHistorical(request, env, pool, timestampSegment, tokenKeySegment)
    }
  } finally {
    await pool.end()
  }

  throw new ApiError('NOT_FOUND', 'Route not found')
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return optionsResponse()
    }

    const url = new URL(request.url)
    const pathname = url.pathname

    let clientId: string | null = null

    try {
      if (pathname === '/api/health' && request.method === 'GET') {
        logRequest(request, null)
        return handleHealth()
      }

      ;({ clientId } = authenticateRequest(request, env))
      logRequest(request, clientId)

      // Serve from Cloudflare's edge cache before doing any work (Enso fetch / DB query).
      const cached = request.method === 'GET' ? await readEdgeCache(request) : undefined
      if (cached) {
        return cached
      }

      const response = await routePriceRequest(request, env, pathname)
      if (request.method === 'GET') {
        writeEdgeCache(ctx, request, response)
      }
      return response
    } catch (error) {
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
        const notFoundCacheable = pathname.startsWith('/api/prices/historical/')
        const headers = error.code === 'NOT_FOUND' && notFoundCacheable
          ? withCors(notFoundErrorHeaders())
          : withCors()
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
      return jsonError(new ApiError('INTERNAL_ERROR', 'Unexpected internal error'), withCors())
    }
  },
}
