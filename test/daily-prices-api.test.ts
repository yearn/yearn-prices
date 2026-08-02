import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import worker from '../src/index'
import { ApiError } from '../src/errors'
import {
  handleDailyEnqueue,
  handleDailyPriceRead,
  parseDailyEnqueuePayload,
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
