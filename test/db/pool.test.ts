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

  it('queries neon.tech over HTTP, not WebSocket', () => {
    createPool('postgres://user:pass@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require')
    expect(neonConfig.poolQueryViaFetch).toBe(true)
    expect(neonConfig.useSecureWebSocket).toBe(snapshot.useSecureWebSocket)
  })
})

describe('pool query retry', () => {
  it('retries once on transient neon HTTP 5xx', async () => {
    const pool = createPool('postgres://user:pass@ep-example.us-east-2.aws.neon.tech/neondb')
    let calls = 0
    const original = Object.getPrototypeOf(pool).query
    Object.getPrototypeOf(pool).query = async () => {
      calls++
      if (calls === 1) throw new Error('Server error (HTTP status 524): error code: 524')
      return { rows: [1] }
    }
    try {
      const fresh = createPool('postgres://user:pass@ep-example.us-east-2.aws.neon.tech/neondb')
      await expect(fresh.query('select 1')).resolves.toEqual({ rows: [1] })
      expect(calls).toBe(2)
      calls = 0
      Object.getPrototypeOf(pool).query = async () => {
        calls++
        throw new Error('syntax error')
      }
      const other = createPool('postgres://user:pass@ep-example.us-east-2.aws.neon.tech/neondb')
      await expect(other.query('select 1')).rejects.toThrow('syntax error')
      expect(calls).toBe(1)
    } finally {
      Object.getPrototypeOf(pool).query = original
    }
  })
})
