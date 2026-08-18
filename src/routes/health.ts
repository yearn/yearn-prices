import { jsonResponse } from '../http'
import { nowUnix } from '../utils'

export function handleHealth(): Response {
  return jsonResponse({
    status: 'ok',
    timestamp: nowUnix()
  })
}
