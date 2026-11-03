import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'
import observations from '../../src/prices/rejected-observations-2026-10.json'

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}

const IMAGE = 'postgres:16-alpine'
const READINESS_ATTEMPTS = 60

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

function waitForReadiness(containerId: string): void {
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    try {
      docker(['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'price_service_test'])
      return
    } catch {
      execFileSync('sleep', ['1'])
    }
  }
  throw new Error('Postgres container did not become ready')
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await migrate(drizzle(client), { migrationsFolder: join(process.cwd(), 'drizzle') })
    await client.query(
      `INSERT INTO rejected_price_observations (chain, token, timestamp, source, reason)
       SELECT item->>'chain', item->>'token', to_timestamp((item->>'timestamp')::bigint),
         source, 'Confirmed invalid provider observation; issue #' || (item->>'issue')
       FROM jsonb_array_elements($1::jsonb) item
       CROSS JOIN (VALUES ('defillama'), ('defillama-alias')) sources(source)`,
      [JSON.stringify(observations)]
    )
  } finally {
    await client.end()
  }
}

export default async function setup(project: TestProject) {
  const containerId = docker([
    'run',
    '-d',
    '--rm',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=price_service_test',
    '-p',
    '127.0.0.1::5432',
    IMAGE
  ])

  try {
    const mapping = docker(['port', containerId, '5432/tcp'])
    const port = mapping.split('\n')[0].split(':').pop()
    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/price_service_test`

    waitForReadiness(containerId)
    await applyMigrations(databaseUrl)
    project.provide('databaseUrl', databaseUrl)
  } catch (error) {
    docker(['stop', containerId])
    throw error
  }

  return () => {
    docker(['stop', containerId])
  }
}
