import type { Pool } from '@neondatabase/serverless'
import type { SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/neon-serverless'
import * as schema from './schema'

/** Shared connection surface for Neon pools and checked-out clients. */
export interface DatabaseConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>
}

type Database = ReturnType<typeof drizzle<typeof schema>>
const connections = new WeakMap<DatabaseConnection, Database>()

/** Drizzle must use the supplied connection, especially inside a transaction. */
export function database(connection: DatabaseConnection) {
  let db = connections.get(connection)
  if (!db) {
    // These structural connections are Neon pools or checked-out Neon clients.
    db = drizzle(connection as Pool, { schema })
    connections.set(connection, db)
  }
  return db
}

/** Execute composed Drizzle SQL for PostgreSQL-specific bulk and maintenance work. */
export async function executeSql<R = Record<string, unknown>>(connection: DatabaseConnection, statement: SQL) {
  const result = await database(connection).execute(statement)
  return { ...result, rows: result.rows as R[] }
}
