import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProxyPoolFromEnv,
  DEFAULT_PUBLIC_PROXY_LIST_URL,
  normalizeProxy,
  ProxyPool
} from '../../src/clients/proxy-pool'

describe('proxy pool', () => {
  afterEach(() => vi.restoreAllMocks())

  it('normalizes public entries and rejects private routes', () => {
    expect(normalizeProxy('1.2.3.4:8080')).toBe('http://1.2.3.4:8080/')
    expect(normalizeProxy('http://127.0.0.1:8080')).toBeNull()
    expect(normalizeProxy('http://localhost:8080')).toBeNull()
    expect(normalizeProxy('ftp://1.2.3.4:21')).toBeNull()
  })

  it('uses direct once, then rotates after a route failure', () => {
    const pool = new ProxyPool({ proxies: ['1.2.3.4:8080', '2.3.4.5:8080'], failureCooldownMs: 60_000 })
    expect(pool.next()).toBeNull()
    pool.reportFailure(null)
    expect(pool.next()).toBe('http://1.2.3.4:8080/')
    pool.reportFailure('http://1.2.3.4:8080/')
    expect(pool.next()).toBe('http://2.3.4.5:8080/')
  })

  it('coalesces list refreshes and keeps malformed/private entries out', async () => {
    let calls = 0
    const pool = new ProxyPool({
      listUrls: ['https://list.example/proxies.txt'],
      fetchImpl: vi.fn(async () => {
        calls += 1
        return new Response('1.2.3.4:8080\n127.0.0.1:8080\n')
      }) as typeof fetch
    })
    await Promise.all([pool.refresh(true), pool.refresh(true)])
    expect(calls).toBe(1)
    expect(pool.next()).toBeNull()
    pool.reportFailure(null)
    expect(pool.next()).toBe('http://1.2.3.4:8080/')
  })

  it('still rotates after a provider Retry-After outlasts the route quarantine', () => {
    let now = 1
    const pool = new ProxyPool({ proxies: ['1.2.3.4:8080'], failureCooldownMs: 60_000, now: () => now })
    expect(pool.next()).toBeNull()
    pool.reportFailure(null)
    now += 120_000
    expect(pool.next()).toBe('http://1.2.3.4:8080/')
    pool.reportSuccess('http://1.2.3.4:8080/')
    expect(pool.next()).toBe('http://1.2.3.4:8080/')
  })

  it('opts into the published public list explicitly', () => {
    const pool = createProxyPoolFromEnv({ PRICE_PROXY_PUBLIC_LIST: 'true' })
    expect(pool).toBeInstanceOf(ProxyPool)
    expect(DEFAULT_PUBLIC_PROXY_LIST_URL).toContain('proxifly/free-proxy-list')
  })
})
