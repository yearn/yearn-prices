import { jsonResponse } from '../http'
import { nowUnix } from '../time'

export function handleHealth(): Response {
  return jsonResponse({
    status: 'ok',
    timestamp: nowUnix(),
  })
}
