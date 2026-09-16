import { neonConfig } from '@neondatabase/serverless'
import { afterEach, describe, expect, it } from 'vitest'
import { createPool } from '../../src/db'

const snapshot = {
  fetchEndpoint: neonConfig.fetchEndpoint,
  useSecureWebSocket: neonConfig.useSecureWebSocket,
  wsProxy: neonConfig.wsProxy,
  pipelineTLS: neonConfig.pipelineTLS,
  pipelineConnect: neonConfig.pipelineConnect,
  poolQueryViaFetch: neonConfig.poolQueryViaFetch
}

afterEach(() => {
  neonConfig.fetchEndpoint = snapshot.fetchEndpoint
  neonConfig.useSecureWebSocket = snapshot.useSecureWebSocket
  neonConfig.wsProxy = snapshot.wsProxy
  neonConfig.pipelineTLS = snapshot.pipelineTLS
  neonConfig.pipelineConnect = snapshot.pipelineConnect
  neonConfig.poolQueryViaFetch = snapshot.poolQueryViaFetch
})

describe('createPool', () => {
  it('routes db.localtest.me through the local neon HTTP proxy', () => {
    const pool = createPool('postgres://postgres:postgres@db.localtest.me:54329/price_service')
    expect(neonConfig.poolQueryViaFetch).toBe(true)
    expect(neonConfig.useSecureWebSocket).toBe(false)
    expect(String(neonConfig.fetchEndpoint('db.localtest.me'))).toBe('http://db.localtest.me:4444/sql')
    expect(neonConfig.wsProxy?.('db.localtest.me')).toBe('db.localtest.me:4444/v2')
    void pool.end()
  })

  it('leaves neon.tech connection config alone', () => {
    createPool('postgres://user:pass@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require')
    expect(neonConfig.poolQueryViaFetch).toBe(snapshot.poolQueryViaFetch)
    expect(neonConfig.useSecureWebSocket).toBe(snapshot.useSecureWebSocket)
  })
})
