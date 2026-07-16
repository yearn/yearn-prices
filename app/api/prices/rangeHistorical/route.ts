import { handleOptions, withApiHandler } from '@/lib/api/handler'
import { ensure } from '@/lib/api/errors'
import { handleRangeHistorical } from '@/lib/prices/range'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return withApiHandler(request, { auth: true, db: true }, async ({ env, pool }) => {
    ensure(pool, 'INTERNAL_ERROR', 'Database pool is not available')
    return handleRangeHistorical(request, env, pool)
  })
}

export function OPTIONS(): Response {
  return handleOptions()
}
