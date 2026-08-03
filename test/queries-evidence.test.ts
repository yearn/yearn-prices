import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import { getHistoricalPriceEvidenceCandidates, insertTokenPrices } from '../src/queries'

const EOD = 1_704_153_599
const TOKEN = '0x0000000000000000000000000000000000000001'

describe('EOD evidence queries', () => {
  test('requires an exact UTC EOD key', async () => {
    await expect(getHistoricalPriceEvidenceCandidates(
      { query: vi.fn() } as unknown as Pool,
      { chain: 'ethereum', token: TOKEN, timestamp: EOD - 1 },
    )).rejects.toThrow('exact UTC EOD')
  })

  test('matches only rows stored at the exact EOD timestamp', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      chain: 'ethereum',
      token: TOKEN,
      timestamp: new Date(EOD * 1_000).toISOString(),
      requested_timestamp: new Date(EOD * 1_000).toISOString(),
      observed_timestamp: new Date((EOD - 60) * 1_000).toISOString(),
      price: '100.5',
      symbol: 'TEST',
      confidence: '0.9',
      source: 'defillama',
      candidate_id: 'defillama-historical',
      evidence_kind: 'observed',
      quality: 'near-eod',
      adapter: 'defillama-historical',
      block_number: '19000000',
      input_evidence: [],
      validation_status: 'validated',
      failure_reason: null,
      evidence_metadata: { providerIdentifier: `ethereum:${TOKEN}` },
    }] })
    const result = await getHistoricalPriceEvidenceCandidates(
      { query } as unknown as Pool,
      { chain: 'ethereum', token: TOKEN, timestamp: EOD },
    )
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('price.timestamp = requested.requested_timestamp')
    expect(sql).not.toContain('BETWEEN')
    expect(params).toEqual([0, 'ethereum', TOKEN, '2024-01-01T23:59:59.000Z'])
    expect(result[0]).toMatchObject({
      requestedTimestamp: EOD,
      observedTimestamp: EOD - 60,
      observationDistance: 60,
      quality: 'near-eod',
      blockNumber: 19_000_000,
      candidateId: 'defillama-historical',
    })
  })
})
describe('evidence persistence', () => {
  test('writes additive provenance without collapsing recursive inputs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await insertTokenPrices({ query } as unknown as Pool, [{
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      price: 2,
      symbol: 'yvTEST',
      confidence: null,
      source: 'derived',
      observedTimestamp: EOD - 10,
      classification: 'derived',
      quality: 'near-eod',
      adapter: 'erc-4626',
      blockNumber: 19_000_000,
      inputs: [{
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000002',
        observedTimestamp: EOD - 20,
        priceUsd: 1,
        source: 'defillama',
        adapter: 'defillama-historical',
        classification: 'observed',
        quality: 'near-eod',
      }],
      validationStatus: 'validated',
      metadata: { convertToAssets: '2000000' },
    }])
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('input_evidence')
    expect(sql).toContain('evidence_metadata')
    expect(params).toContain('erc-4626')
    expect(params).toContain(JSON.stringify({ convertToAssets: '2000000' }))
  })

  test('allows accepted EOD evidence to upgrade an unvalidated legacy conflict', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await insertTokenPrices({ query } as unknown as Pool, [{
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      price: 1,
      symbol: 'TEST',
      confidence: 0.99,
      source: 'defillama',
      observedTimestamp: EOD - 60,
      classification: 'observed',
      quality: 'near-eod',
      adapter: 'defillama-historical',
      validationStatus: 'validated',
    }])
    const [sql] = query.mock.calls[0]
    expect(sql).toContain('DO UPDATE SET')
    expect(sql).toContain("EXCLUDED.validation_status = 'validated'")
    expect(sql).toContain("COALESCE(token_prices.validation_status, 'legacy-unvalidated') = 'legacy-unvalidated'")
  })

  test('preserves multiple derived adapters under distinct candidate identities', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const base = {
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      price: 1,
      symbol: 'LP',
      confidence: null,
      source: 'derived' as const,
      observedTimestamp: EOD,
      classification: 'derived' as const,
      quality: 'exact' as const,
      validationStatus: 'validated' as const,
      inputs: [{
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000002',
        observedTimestamp: EOD,
        priceUsd: 1,
        source: 'defillama',
        adapter: 'defillama-historical',
        classification: 'observed' as const,
        quality: 'exact' as const,
      }],
    }

    await insertTokenPrices({ query } as unknown as Pool, [
      { ...base, adapter: 'amm-reserve-nav' },
      { ...base, adapter: 'curve-reserve-nav' },
    ])

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (chain, token, timestamp, source, candidate_id)')
    expect(params).toContain('amm-reserve-nav')
    expect(params).toContain('curve-reserve-nav')
    expect(params).toHaveLength(34)
  })
})
