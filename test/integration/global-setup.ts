import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
  }
}

const IMAGE = 'postgres:16-alpine'
const MIGRATIONS_DIRECTORY = join(process.cwd(), 'migrations')
const READINESS_ATTEMPTS = 60

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

function waitForReadiness(containerId: string): void {
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    try {
      docker(['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', 'price_service_test'])
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
  const require = createRequire(join(MIGRATIONS_DIRECTORY, 'index.cjs'))
  const db = { runSql: (sql: string) => client.query(sql) }

  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => file.endsWith('.js'))
    .sort()

  try {
    for (const file of files) {
      const migration = require(join(MIGRATIONS_DIRECTORY, file)) as { up: (db: unknown) => Promise<unknown> }
      await migration.up(db)
    }
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
