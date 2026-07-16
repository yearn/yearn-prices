import { handleOptions, withApiHandler } from '@/lib/api/handler'
import { handleHealth } from '@/lib/prices/health'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return withApiHandler(request, { auth: false, edgeCache: false }, async () => handleHealth())
}

export function OPTIONS(): Response {
  return handleOptions()
}
