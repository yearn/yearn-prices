import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import worker from '../src/index'
import { ApiError } from '../src/errors'
import {
  handleDailyBatchRead,
  handleDailyEnqueue,
  handleDailyPriceRead,
  handleDailyRequeue,
  parseDailyEnqueuePayload,
  parseDailyRequeuePayload,
} from '../src/routes/daily-prices'
import type { PriceEvidenceCandidate } from '../src/types'
import { parseStrictEodBatchCoins } from '../src/validation'

const TOKEN = '0x0000000000000000000000000000000000000001'
const EOD = 1_704_153_599

function candidate(): PriceEvidenceCandidate {
  return {
    chain: 'ethereum',
    token: TOKEN,
    requestedTimestamp: EOD,
    observedTimestamp: EOD - 60,
    observationDistance: 60,
    observationOffsetSeconds: -60,
    observationDirection: 'before',
    priceUsd: 1,
    symbol: 'TEST',
    confidence: 0.99,
    source: 'defillama',
    candidateId: 'defillama-historical',
    adapter: 'defillama-historical',
    classification: 'observed',
    quality: 'near-eod',
    blockNumber: null,
    inputs: [],
    validationStatus: 'validated',
    failureReason: null,
    metadata: {},
  }
}

describe('daily enqueue API', () => {
  test('requires API authentication before enqueueing', async () => {
    const response = await worker.fetch(
      new Request('https://prices.local/api/daily-prices/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          day: '2024-01-01',
          targets: [{ chain: 'ethereum', token: TOKEN }],
        }),
      }),
      {
        DATABASE_URL: 'postgres://unused',
        PRICE_API_KEYS: JSON.stringify({ operations: 'secret' }),
      },
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    })
  })

  test('rejects read-only application keys before opening the database', async () => {
    const response = await worker.fetch(
      new Request('https://prices.local/api/daily-prices/enqueue', {
        method: 'POST',
        headers: { authorization: 'Bearer frontend-key' },
        body: JSON.stringify({
          day: '2024-01-01',
          targets: [{ chain: 'ethereum', token: TOKEN }],
        }),
      }),
      {
        DATABASE_URL: 'postgres://unused',
        API_KEY_FRONTEND: 'frontend-key',
      },
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    })
  })

  test('scopes and deduplicates a closed UTC day', () => {
    const parsed = parseDailyEnqueuePayload({
      day: '2024-01-01',
      targets: [
        { chain: 'Ethereum', token: TOKEN },
        { chain: 'ethereum', token: TOKEN.toUpperCase().replace('0X', '0x') },
      ],
    }, EOD + 1)

    expect(parsed).toEqual({
      eodTimestamp: EOD,
      targets: [{
        chain: 'ethereum',
        token: TOKEN,
        eodTimestamp: EOD,
        metadata: { origin: 'daily-enqueue-api' },
      }],
    })
  })

  test('rejects open days and oversized target sets', () => {
    expect(() => parseDailyEnqueuePayload({
      day: '2024-01-02',
      targets: [{ chain: 'ethereum', token: TOKEN }],
    }, EOD + 1)).toThrow('closed UTC day')

    expect(() => parseDailyEnqueuePayload({
      day: '2024-01-01',
      targets: Array.from({ length: 501 }, () => ({ chain: 'ethereum', token: TOKEN })),
    }, EOD + 1)).toThrow('maximum of 500')
  })

  test('enforces the body limit in bytes when content-length is unavailable', async () => {
    const request = new Request('https://prices.local/api/daily-prices/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        day: '2024-01-01',
        targets: [{ chain: 'ethereum', token: TOKEN }],
        note: '💾'.repeat(40_000),
      }),
    })
    request.headers.delete('content-length')

    await expect(handleDailyEnqueue(request, {} as Pool)).rejects.toThrow('must not exceed')
  })

  test('returns accepted rows immediately and enqueues only missing targets', async () => {
    const secondToken = '0x0000000000000000000000000000000000000002'
    const enqueue = vi.fn().mockResolvedValue(1)
    const loadTargets = vi.fn().mockResolvedValue([{
      id: 1,
      chain: 'ethereum',
      token: secondToken,
      eodTimestamp: EOD,
      status: 'retryable',
      attemptCount: 0,
      adapter: null,
      failureClass: null,
      failureReason: 'HTTP 503 from https://rpc.example/v1?apiKey=secret-value',
      metadata: {},
    }])
    const response = await handleDailyEnqueue(
      new Request('https://prices.local/api/daily-prices/enqueue', {
        method: 'POST',
        body: JSON.stringify({
          day: '2024-01-01',
          targets: [
            { chain: 'ethereum', token: TOKEN },
            { chain: 'ethereum', token: secondToken },
          ],
        }),
      }),
      {} as Pool,
      {
        loadCandidates: vi.fn().mockResolvedValue([candidate()]),
        enqueue,
        loadTargets,
      },
    )
    const body = await response.json() as Record<string, any>

    expect(response.status).toBe(202)
    expect(body).toMatchObject({
      eodTimestamp: EOD,
      requested: 2,
      deduplicated: 2,
      alreadyPriced: 1,
      inserted: 1,
      existingQueue: 0,
      coverage: { priced: 1, total: 2, complete: false },
    })
    expect(enqueue).toHaveBeenCalledWith({}, [
      expect.objectContaining({ token: secondToken, eodTimestamp: EOD }),
    ])
    expect(body.targets[1].failureReason).toContain('<redacted-url>')
    expect(body.targets[1].failureReason).not.toContain('rpc.example')
    expect(body.targets[1].failureReason).not.toContain('secret-value')
  })
})

describe('daily requeue API', () => {
  test('parses exact targets and reviewed filter scopes', () => {
    expect(parseDailyRequeuePayload({
      reason: 'Adapter v2 now supports this contract',
      targets: [{ chain: 'ethereum', token: TOKEN, day: '2024-01-01' }],
    }, 'operations', EOD + 1)).toMatchObject({
      requestedBy: 'operations',
      scope: { targets: [{ chain: 'ethereum', token: TOKEN, eodTimestamp: EOD }] },
    })

    expect(parseDailyRequeuePayload({
      reason: 'Policy review approved adapter version',
      filter: {
        chain: 'ethereum',
        day: '2024-01-01',
        statuses: ['quarantined'],
        adapterVersion: 'amm-nav-v2',
      },
    }, 'operations', EOD + 1)).toMatchObject({
      scope: {
        filter: {
          chain: 'ethereum',
          eodTimestamp: EOD,
          statuses: ['quarantined'],
          adapterVersion: 'amm-nav-v2',
        },
      },
    })
  })

  test('requires one bounded scope and an audit reason', () => {
    expect(() => parseDailyRequeuePayload({ targets: [] }, 'operations', EOD + 1)).toThrow('reason is required')
    expect(() => parseDailyRequeuePayload({
      reason: 'ambiguous',
      targets: [{ chain: 'ethereum', token: TOKEN, day: '2024-01-01' }],
      filter: { chain: 'ethereum', day: '2024-01-01' },
    }, 'operations', EOD + 1)).toThrow('exactly one')
  })

  test('returns the durable audit id from an authenticated requeue', async () => {
    const requeue = vi.fn().mockResolvedValue({
      auditId: 42,
      requeued: 1,
      targets: [{ id: 7, chain: 'ethereum', token: TOKEN, eodTimestamp: EOD }],
    })
    const response = await handleDailyRequeue(
      new Request('https://prices.local/api/daily-prices/requeue', {
        method: 'POST',
        body: JSON.stringify({
          reason: 'Reviewed mapping added',
          targets: [{ chain: 'ethereum', token: TOKEN, day: '2024-01-01' }],
        }),
      }),
      {} as Pool,
      'operations',
      { requeue },
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ auditId: 42, requeued: 1 })
    expect(requeue).toHaveBeenCalledWith({}, expect.objectContaining({ requestedBy: 'operations' }))
  })
})
describe('strict daily reads', () => {
  test('rejects intraday keys before querying storage', async () => {
    const query = vi.fn()
    await expect(handleDailyPriceRead(
      new Request('https://prices.local'),
      { query } as unknown as Pool,
      String(EOD - 1),
      `ethereum:${TOKEN}`,
    )).rejects.toBeInstanceOf(ApiError)
    expect(query).not.toHaveBeenCalled()
  })

  test('returns no accepted price when the exact EOD row is missing', async () => {
    const response = await handleDailyPriceRead(
      new Request('https://prices.local'),
      { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool,
      String(EOD),
      `ethereum:${TOKEN}`,
    )
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
      validation: { status: 'unavailable' },
    })
  })

  test('does not let a source filter hide canonical disagreement', async () => {
    const row = (source: 'defillama' | 'on-chain-oracle', price: string, candidateId: string) => ({
      chain: 'ethereum',
      token: TOKEN,
      timestamp: new Date(EOD * 1_000).toISOString(),
      requested_timestamp: new Date(EOD * 1_000).toISOString(),
      observed_timestamp: new Date((EOD - 60) * 1_000).toISOString(),
      price,
      symbol: 'TEST',
      confidence: '0.9',
      source,
      candidate_id: candidateId,
      evidence_kind: 'observed',
      quality: 'near-eod',
      adapter: candidateId,
      block_number: null,
      input_evidence: [],
      validation_status: 'validated',
      failure_reason: null,
      evidence_metadata: {},
    })
    const query = vi.fn().mockResolvedValue({
      rows: [
        row('defillama', '100', 'defillama-historical'),
        row('on-chain-oracle', '80', 'oracle'),
      ],
    })

    const response = await handleDailyPriceRead(
      new Request('https://prices.local?source=defillama'),
      { query } as unknown as Pool,
      String(EOD),
      `ethereum:${TOKEN}`,
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'QUARANTINED' },
      validation: { failureClass: 'disagreement' },
    })
    const [sql, params] = query.mock.calls[0]
    expect(sql).not.toContain('price.source =')
    expect(params).not.toContain('defillama')
  })
})

describe('strict daily batch reads', () => {
  const batchRequest = (coins: Record<string, Array<number | string>>, source?: string) => {
    const url = new URL('https://prices.local/api/daily-prices/batch')
    url.searchParams.set('coins', JSON.stringify(coins))
    if (source) url.searchParams.set('source', source)
    return new Request(url)
  }

  test('requires API authentication before opening storage', async () => {
    const response = await worker.fetch(
      batchRequest({ [`ethereum:${TOKEN}`]: [EOD] }),
      { DATABASE_URL: 'postgres://unused', API_KEY_TVL: 'tvl-key' },
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  test('normalizes, deduplicates, and deterministically orders exact EOD targets', () => {
    const secondToken = '0x0000000000000000000000000000000000000002'
    expect(parseStrictEodBatchCoins(JSON.stringify({
      [`Ethereum:${secondToken}`]: [EOD, EOD],
      [`ethereum:${TOKEN}`]: [String(EOD)],
    }), EOD + 1)).toEqual([
      { chain: 'ethereum', token: TOKEN, timestamp: EOD },
      { chain: 'ethereum', token: secondToken, timestamp: EOD },
    ])

    expect(() => parseStrictEodBatchCoins(JSON.stringify({
      [`ethereum:${TOKEN}`]: [EOD - 1],
    }), EOD + 1)).toThrow('exactly 23:59:59 UTC')
    expect(() => parseStrictEodBatchCoins(JSON.stringify({
      [`unknown:${TOKEN}`]: [EOD],
    }), EOD + 1)).toThrow('Unsupported chain')
  })

  test('returns explicit partial-batch outcomes with priced provenance and durable failure classes', async () => {
    const retryableToken = '0x0000000000000000000000000000000000000002'
    const quarantinedToken = '0x0000000000000000000000000000000000000003'
    const missingToken = '0x0000000000000000000000000000000000000004'
    const response = await handleDailyBatchRead(
      batchRequest({
        [`ethereum:${missingToken}`]: [EOD],
        [`ethereum:${quarantinedToken}`]: [EOD],
        [`ethereum:${TOKEN}`]: [EOD],
        [`ethereum:${retryableToken}`]: [EOD],
      }),
      {} as Pool,
      {
        loadCandidates: vi.fn().mockResolvedValue([
          candidate(),
          { ...candidate(), token: quarantinedToken, validationStatus: 'quarantined', failureReason: 'invalid derivation' },
        ]),
        loadTargets: vi.fn().mockResolvedValue([
          {
            id: 2,
            chain: 'ethereum',
            token: retryableToken,
            eodTimestamp: EOD,
            status: 'retryable',
            attemptCount: 2,
            adapter: 'historical-market-price',
            failureClass: 'retryable',
            failureReason: 'HTTP 503 from https://rpc.example/key/secret',
            metadata: {},
          },
          {
            id: 3,
            chain: 'ethereum',
            token: quarantinedToken,
            eodTimestamp: EOD,
            status: 'quarantined',
            attemptCount: 3,
            adapter: 'erc4626',
            failureClass: 'invalid',
            failureReason: 'invalid derivation',
            metadata: {},
          },
        ]),
      },
    )
    const body = await response.json() as Record<string, any>

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.summary).toEqual({ requested: 4, priced: 1, unavailable: 2, quarantined: 1 })
    expect(body.results).toEqual([
      expect.objectContaining({ token: TOKEN, status: 'priced', price: 1, source: 'defillama', adapter: 'defillama-historical', candidateId: 'defillama-historical', classification: 'observed', quality: 'near-eod', observedTimestamp: EOD - 60, validationStatus: 'validated' }),
      expect.objectContaining({ token: retryableToken, status: 'unavailable', failureClass: 'retryable' }),
      expect.objectContaining({ token: quarantinedToken, status: 'quarantined', failureClass: 'invalid' }),
      expect.objectContaining({ token: missingToken, status: 'unavailable', failureClass: 'not-found' }),
    ])
    expect(body.results[1].failureReason).toContain('<redacted-url>')
    expect(body.results[2]).not.toHaveProperty('price')
  })

  test('returns every target on total failure', async () => {
    const secondToken = '0x0000000000000000000000000000000000000002'
    const response = await handleDailyBatchRead(
      batchRequest({ [`ethereum:${secondToken}`]: [EOD], [`ethereum:${TOKEN}`]: [EOD] }),
      {} as Pool,
      {
        loadCandidates: vi.fn().mockResolvedValue([]),
        loadTargets: vi.fn().mockResolvedValue([]),
      },
    )
    await expect(response.json()).resolves.toMatchObject({
      summary: { requested: 2, priced: 0, unavailable: 2, quarantined: 0 },
      results: [
        { token: TOKEN, status: 'unavailable', failureClass: 'not-found' },
        { token: secondToken, status: 'unavailable', failureClass: 'not-found' },
      ],
    })
  })

  test('does not let a source filter hide independent disagreement', async () => {
    const response = await handleDailyBatchRead(
      batchRequest({ [`ethereum:${TOKEN}`]: [EOD] }, 'defillama'),
      {} as Pool,
      {
        loadCandidates: vi.fn().mockResolvedValue([
          { ...candidate(), priceUsd: 100 },
          { ...candidate(), priceUsd: 80, source: 'on-chain-oracle', candidateId: 'oracle', adapter: 'oracle' },
        ]),
        loadTargets: vi.fn().mockResolvedValue([]),
      },
    )

    await expect(response.json()).resolves.toMatchObject({
      results: [{ status: 'quarantined', failureClass: 'disagreement' }],
    })
  })
})
