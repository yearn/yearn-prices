import { jsonResponse } from '@/lib/api/http'
import { nowUnix } from '@/lib/time'

export function handleHealth(): Response {
  return jsonResponse({
    status: 'ok',
    timestamp: nowUnix(),
  })
}
