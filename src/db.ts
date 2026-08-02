import { Pool } from '@neondatabase/serverless'

let websocketConfigured = false

function connectionStringForSchema(connectionString: string, schema: string | undefined): string {
  if (!schema) return connectionString
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DATABASE_SCHEMA must be a safe Postgres identifier')
  const url = new URL(connectionString)
  const existingOptions = url.searchParams.get('options')?.trim()
  url.searchParams.set('options', [existingOptions, `-c search_path=${schema}`].filter(Boolean).join(' '))
  return url.toString()
}

export function createPool(connectionString: string, schema?: string): Pool {
  if (!websocketConfigured && typeof process !== 'undefined') {
    websocketConfigured = true
  }

  return new Pool({ connectionString: connectionStringForSchema(connectionString, schema) })
}
