import { Pool } from '@neondatabase/serverless'

let websocketConfigured = false

export function createPool(connectionString: string): Pool {
  if (!websocketConfigured && typeof process !== 'undefined') {
    websocketConfigured = true
  }

  return new Pool({ connectionString })
}
