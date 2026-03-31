import { authenticateRequest } from './auth'
import { createPool } from './db'
import { ApiError, jsonError } from './errors'
import { optionsResponse, withCors } from './http'
import { handleHealth } from './routes/health'
import { handleBatchHistorical, handleHistorical, handleRangeHistorical, notFoundErrorHeaders } from './routes/prices'
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        const headers = error.code === 'NOT_FOUND' && pathname.startsWith('/api/prices/historical/')
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
