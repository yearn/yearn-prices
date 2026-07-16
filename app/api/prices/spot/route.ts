import { handleOptions, withApiHandler } from '@/lib/api/handler'
import { handleSpot } from '@/lib/prices/spot'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  return withApiHandler(request, { auth: true }, async ({ env }) => handleSpot(request, env))
}

export function OPTIONS(): Response {
  return handleOptions()
}
