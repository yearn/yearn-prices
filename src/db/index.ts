import { neonConfig, Pool } from '@neondatabase/serverless'

const LOCAL_NEON_HOSTS = new Set(['db.localtest.me', 'localhost', '127.0.0.1'])

function connectionHostname(connectionString: string): string | null {
  try {
    return new URL(connectionString.replace(/^postgres(ql)?:/i, 'http:')).hostname
  } catch {
    return null
  }
}

function configureLocalNeon(host: string): void {
  neonConfig.fetchEndpoint = (target) => {
    const hostname = target === 'db.localtest.me' ? 'db.localtest.me' : '127.0.0.1'
    return `http://${hostname}:4444/sql`
  }
  neonConfig.useSecureWebSocket = false
  neonConfig.wsProxy = () => (host === 'db.localtest.me' ? 'db.localtest.me:4444/v2' : '127.0.0.1:4444/v2')
  neonConfig.pipelineTLS = false
  neonConfig.pipelineConnect = false
  neonConfig.poolQueryViaFetch = true
}

export function createPool(connectionString: string): Pool {
  const host = connectionHostname(connectionString)
  if (host && LOCAL_NEON_HOSTS.has(host)) {
    configureLocalNeon(host)
  }

  return new Pool({ connectionString })
}

export * from './queries'
