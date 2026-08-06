import type { Pool } from '@neondatabase/serverless'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from '../src/db'
import { normalizeTokenAddress } from '../src/chains'
import {
  ONCHAIN_ADAPTER_VERSION,
  PRICE_SELECTION_POLICY_VERSION,
} from '../src/candidate-identity'
import {
  claimDailyPriceTargets,
  enqueueDailyPriceTargets,
  getDailyPriceTargets,
  markDailyPriceTargetsPriced,
  reconcileDailyPriceTargetMetadata,
  requeueDailyPriceTargets,
  recordUnsupportedDailyPriceTargets,
} from '../src/daily-prices'
import { processDailyPriceTarget } from '../src/daily-price-worker'
import { selectEodPriceEvidence } from '../src/evidence'
import { getBatchHistoricalPriceEvidenceCandidates, insertTokenPrices } from '../src/queries'

const databaseUrl = process.env.DATABASE_URL
const databaseSchema = process.env.DATABASE_SCHEMA
const enabled = Boolean(databaseUrl && databaseSchema?.startsWith('yearn_prices_validation_'))
const TOKEN = '0x00000000000000000000000000000000000000e0'
const STALE_TOKEN = '0x00000000000000000000000000000000000000e1'
const CANDIDATE_TOKEN = '0x00000000000000000000000000000000000000e2'
const RETRY_TOKEN = '0x00000000000000000000000000000000000000e3'
const VERSION_TOKEN = '0x00000000000000000000000000000000000000e4'
const INVENTORY_TOKEN = '0x00000000000000000000000000000000000000e5'
const EOD = 1_704_153_599
const VERSION_EOD = 946_771_199
const TEST_TOKENS = [TOKEN, STALE_TOKEN, CANDIDATE_TOKEN, RETRY_TOKEN, VERSION_TOKEN, INVENTORY_TOKEN]

describe.skipIf(!enabled)('isolated Postgres integration', () => {
  let pool: Pool

  beforeAll(async () => {
    if (!databaseUrl || !databaseSchema) throw new Error('isolated database is not configured')
    pool = createPool(databaseUrl, databaseSchema)
    await pool.query('DELETE FROM daily_price_requeue_audits WHERE requested_by = $1', ['postgres-integration'])
    await pool.query('DELETE FROM daily_price_targets WHERE lower(token) = ANY($1::text[])', [TEST_TOKENS.map(token => token.toLowerCase())])
    await pool.query('DELETE FROM token_prices WHERE lower(token) = ANY($1::text[])', [TEST_TOKENS.map(token => token.toLowerCase())])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM daily_price_requeue_audits WHERE requested_by = $1', ['postgres-integration'])
    await pool.query('DELETE FROM daily_price_targets WHERE lower(token) = ANY($1::text[])', [TEST_TOKENS.map(token => token.toLowerCase())])
    await pool.query('DELETE FROM token_prices WHERE lower(token) = ANY($1::text[])', [TEST_TOKENS.map(token => token.toLowerCase())])
    await pool.end()
  })

  it('executes exact-EOD evidence SQL and excludes an intraday row', async () => {
    await insertTokenPrices(pool, [{
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      price: 2,
      symbol: 'EOD',
      confidence: 1,
      source: 'on-chain-oracle',
      observedTimestamp: EOD,
      classification: 'observed',
      quality: 'exact',
      adapter: 'postgres-canary',
      validationStatus: 'validated',
    }])
    await pool.query(
      `INSERT INTO token_prices (chain, token, timestamp, price, source)
       VALUES ('ethereum', $1, to_timestamp($2), 99, 'defillama')`,
      [TOKEN, EOD - 1],
    )

    const candidates = await getBatchHistoricalPriceEvidenceCandidates(pool, [{
      chain: 'ethereum', token: TOKEN, timestamp: EOD,
    }])
    expect(candidates).toHaveLength(1)
    expect(selectEodPriceEvidence(EOD, candidates).selected).toMatchObject({
      priceUsd: 2,
      adapter: 'postgres-canary',
    })
  })

  it('enqueues idempotently and marks accepted evidence as priced', async () => {
    const input = [{ chain: 'ethereum', token: TOKEN, eodTimestamp: EOD }]
    await expect(enqueueDailyPriceTargets(pool, input)).resolves.toBe(1)
    await expect(enqueueDailyPriceTargets(pool, input)).resolves.toBe(0)
    await expect(markDailyPriceTargetsPriced(pool, input, 'postgres-canary')).resolves.toBe(1)
    await expect(getDailyPriceTargets(pool, input)).resolves.toEqual([
      expect.objectContaining({ status: 'priced', adapter: 'postgres-canary' }),
    ])
  })

  it('reconciles inventory metadata and records unsupported chains idempotently', async () => {
    const input = [{
      chain: 'ethereum',
      token: INVENTORY_TOKEN,
      eodTimestamp: EOD,
      metadata: { origin: 'kong-vault-inventory' },
    }]
    await expect(enqueueDailyPriceTargets(pool, input)).resolves.toBe(1)
    await expect(reconcileDailyPriceTargetMetadata(pool, [{
      ...input[0],
      metadata: { origin: 'tvl-price-target-inventory', roles: ['curation'] },
    }])).resolves.toBe(1)
    await expect(getDailyPriceTargets(pool, input)).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ origin: 'tvl-price-target-inventory', roles: ['curation'] }),
      }),
    ])

    const unsupported = [{
      chain: '1234',
      token: INVENTORY_TOKEN,
      eodTimestamp: EOD,
      failureReason: 'yearn-prices has no chain 1234 support',
      metadata: { roles: ['curation'] },
    }]
    await expect(recordUnsupportedDailyPriceTargets(pool, unsupported)).resolves.toBe(1)
    await expect(recordUnsupportedDailyPriceTargets(pool, unsupported)).resolves.toBe(0)
    await expect(pool.query(
      'SELECT status, failure_class, metadata FROM daily_price_targets WHERE chain = $1 AND token = $2 AND eod_at = to_timestamp($3)',
      ['1234', normalizeTokenAddress(INVENTORY_TOKEN), EOD],
    )).resolves.toMatchObject({
      rows: [{ status: 'unsupported', failure_class: 'unsupported', metadata: { roles: ['curation'] } }],
    })
  })

  it('preserves same-source adapter candidates independently', async () => {
    const input = {
      chain: 'ethereum',
      token: CANDIDATE_TOKEN,
      timestamp: EOD,
      symbol: 'LP',
      confidence: null,
      source: 'derived' as const,
      observedTimestamp: EOD,
      classification: 'derived' as const,
      quality: 'exact' as const,
      validationStatus: 'validated' as const,
      inputs: [{
        chain: 'ethereum',
        token: TOKEN,
        observedTimestamp: EOD,
        priceUsd: 1,
        source: 'defillama',
        adapter: 'defillama-historical',
        classification: 'observed' as const,
        quality: 'exact' as const,
      }],
    }
    await insertTokenPrices(pool, [
      { ...input, price: 1, adapter: 'amm-reserve-nav' },
      { ...input, price: 1.01, adapter: 'curve-reserve-nav' },
    ])

    const candidates = await getBatchHistoricalPriceEvidenceCandidates(pool, [{
      chain: 'ethereum', token: CANDIDATE_TOKEN, timestamp: EOD,
    }])
    expect(candidates.map(candidate => candidate.candidateId).sort()).toEqual([
      'amm-reserve-nav',
      'curve-reserve-nav',
    ])
  })

  it('rejects stale evidence before insertion and audits reviewed requeue', async () => {
    const inserted = await pool.query<{ id: string | number }>(
      `INSERT INTO daily_price_targets (chain, token, eod_at, status, attempt_count)
       VALUES ('ethereum', $1, to_timestamp($2), 'in_progress', 2)
       RETURNING id`,
      [STALE_TOKEN, EOD],
    )
    const targetId = Number(inserted.rows[0].id)
    await expect(processDailyPriceTarget(pool, {
      resolve: async () => ({
        path: {
          chain: 'ethereum',
          token: STALE_TOKEN,
          requestedTimestamp: EOD,
          observedTimestamp: EOD,
          priceUsd: 5,
          symbol: 'STALE',
          confidence: 1,
          source: 'defillama',
          adapter: 'defillama-historical',
          classification: 'observed',
          quality: 'exact',
          blockNumber: null,
          inputs: [],
          metadata: {},
        },
        failure: null,
      }),
    }, {
      id: targetId,
      chain: 'ethereum',
      token: STALE_TOKEN,
      eodTimestamp: EOD,
      status: 'in_progress',
      attemptCount: 1,
      adapter: null,
      failureClass: null,
      failureReason: null,
      metadata: {},
    })).rejects.toThrow('owns 0 of 1 target leases')
    const staleEvidence = await pool.query(`SELECT 1 FROM token_prices WHERE lower(token) = $1`, [STALE_TOKEN.toLowerCase()])
    expect(staleEvidence.rows).toHaveLength(0)

    await pool.query(
      `UPDATE daily_price_targets SET status='unsupported', failure_class='unsupported', failure_reason='old policy'
       WHERE id=$1`,
      [targetId],
    )
    const requeued = await requeueDailyPriceTargets(pool, {
      requestedBy: 'postgres-integration',
      reason: 'reviewed policy',
      scope: { targets: [{ chain: 'ethereum', token: STALE_TOKEN, eodTimestamp: EOD }] },
    })
    expect(requeued).toMatchObject({ requeued: 1 })
    await expect(getDailyPriceTargets(pool, [{ chain: 'ethereum', token: STALE_TOKEN, eodTimestamp: EOD }]))
      .resolves.toEqual([expect.objectContaining({ status: 'pending', attemptCount: 0 })])
  })

  it('terminalizes exhausted transient retries without claiming them again', async () => {
    await pool.query(
      `INSERT INTO daily_price_targets (
        chain, token, eod_at, status, attempt_count, failure_class, failure_reason, next_retry_at
       ) VALUES ('ethereum', $1, to_timestamp($2), 'retryable', 3, 'retryable', 'HTTP 503', NOW())`,
      [normalizeTokenAddress(RETRY_TOKEN), EOD],
    )
    await claimDailyPriceTargets(pool, 1, { maxAttempts: 3 })
    await expect(getDailyPriceTargets(pool, [{ chain: 'ethereum', token: RETRY_TOKEN, eodTimestamp: EOD }]))
      .resolves.toEqual([expect.objectContaining({
        status: 'quarantined',
        failureClass: 'retryable',
        failureReason: 'HTTP 503',
        metadata: expect.objectContaining({
          retryExhausted: expect.objectContaining({ originalFailureClass: 'retryable' }),
        }),
      })])
  })

  it('requeues terminal worker outcomes by adapter and policy version', async () => {
    const inserted = await pool.query<{ id: string | number }>(
      `INSERT INTO daily_price_targets (chain, token, eod_at, status, attempt_count)
       VALUES ('ethereum', $1, to_timestamp($2), 'in_progress', 1)
       RETURNING id`,
      [normalizeTokenAddress(VERSION_TOKEN), VERSION_EOD],
    )
    const targetId = Number(inserted.rows[0].id)
    await processDailyPriceTarget(pool, {
      resolve: async () => ({
        path: null,
        failure: {
          reason: 'unsupported',
          token: VERSION_TOKEN,
          attempts: [{
            adapter: 'curve-reserve-nav',
            reason: 'unsupported',
            error: 'Unsupported test constituent',
          }],
        },
      }),
    }, {
      id: targetId,
      chain: 'ethereum',
      token: VERSION_TOKEN,
      eodTimestamp: VERSION_EOD,
      status: 'in_progress',
      attemptCount: 1,
      adapter: null,
      failureClass: null,
      failureReason: null,
      metadata: {},
    })

    await expect(getDailyPriceTargets(pool, [{
      chain: 'ethereum', token: VERSION_TOKEN, eodTimestamp: VERSION_EOD,
    }])).resolves.toEqual([expect.objectContaining({
      status: 'unsupported',
      adapter: 'curve-reserve-nav',
      metadata: expect.objectContaining({
        adapterVersion: ONCHAIN_ADAPTER_VERSION,
        policyVersion: PRICE_SELECTION_POLICY_VERSION,
      }),
    })])

    await expect(requeueDailyPriceTargets(pool, {
      requestedBy: 'postgres-integration',
      reason: 'reviewed adapter and policy versions',
      scope: {
        filter: {
          chain: 'ethereum',
          eodTimestamp: VERSION_EOD,
          statuses: ['unsupported'],
          adapter: 'curve-reserve-nav',
          adapterVersion: ONCHAIN_ADAPTER_VERSION,
          policyVersion: PRICE_SELECTION_POLICY_VERSION,
        },
      },
    })).resolves.toMatchObject({ requeued: 1 })
  })
})
