import { handleOptions, withApiHandler } from '@/lib/api/handler'
import { ensure } from '@/lib/api/errors'
import { handleHistorical } from '@/lib/prices/historical'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type RouteContext = {
  params: Promise<{ timestamp: string; tokenKey: string }>
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { timestamp, tokenKey } = await context.params

  return withApiHandler(
    request,
    { auth: true, db: true, notFoundCacheable: true },
    async ({ env, pool }) => {
      ensure(pool, 'INTERNAL_ERROR', 'Database pool is not available')
      return handleHistorical(request, env, pool, timestamp, tokenKey)
    },
  )
}

export function OPTIONS(): Response {
  return handleOptions()
}
