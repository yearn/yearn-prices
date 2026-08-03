import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import worker from '../src/index'
import { ApiError } from '../src/errors'
import {
  handleDailyEnqueue,
  handleDailyPriceRead,
  handleDailyRequeue,
  parseDailyEnqueuePayload,
  parseDailyRequeuePayload,
} from '../src/routes/daily-prices'
import type { PriceEvidenceCandidate } from '../src/types'

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
      status: 'pending',
      attemptCount: 0,
      adapter: null,
      failureClass: null,
      failureReason: null,
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
})
