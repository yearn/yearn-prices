import type { Pool } from '@neondatabase/serverless'
import { describe, expect, test, vi } from 'vitest'
import { normalizeTokenKey } from '../src/chains'
import { createHistoricalMarketPriceResolver } from '../src/historical-market'
import { RetryablePricingError } from '../src/recursive-pricing'
import { normalizeToEndOfDay, UTC_DAY_SECONDS } from '../src/time'
import type { PriceEvidenceCandidate } from '../src/types'

const TOKEN = '0x0000000000000000000000000000000000000001'
const SECOND_TOKEN = '0x0000000000000000000000000000000000000002'
const OPTIMISM_DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const OPTIMISM_USDCE = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
const OPTIMISM_USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const FANTOM_USDC = '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75'
const FANTOM_USDC_BOUNDARY = 1_688_667_035
const FANTOM_PRE_INCIDENT_EOD = normalizeToEndOfDay(FANTOM_USDC_BOUNDARY) - UTC_DAY_SECONDS
const FANTOM_INCIDENT_DAY_EOD = normalizeToEndOfDay(FANTOM_USDC_BOUNDARY)
const REQUESTED_TIMESTAMP = 1_700_006_399
const pool = {} as Pool

function candidate(overrides: Partial<PriceEvidenceCandidate> = {}): PriceEvidenceCandidate {
  return {
    chain: 'ethereum',
    token: TOKEN,
    requestedTimestamp: REQUESTED_TIMESTAMP,
    observedTimestamp: REQUESTED_TIMESTAMP - 60,
    observationDistance: 60,
    observationOffsetSeconds: -60,
    observationDirection: 'before',
    priceUsd: 100,
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
    ...overrides,
  }
}

describe('historical market resolver', () => {
  test('prefetches targets together and selects only prior batch observations', async () => {
    const getHistorical = vi.fn()
    const getBatchHistorical = vi.fn().mockResolvedValue({
      coins: {
        [`ethereum:${TOKEN}`]: {
          symbol: 'ONE',
          prices: [
            { price: 101, timestamp: REQUESTED_TIMESTAMP + 5 },
            { price: 100, timestamp: REQUESTED_TIMESTAMP - 20, confidence: 0.98 },
          ],
        },
        [`ethereum:${SECOND_TOKEN}`]: {
          symbol: 'TWO',
          prices: [{ price: 202, timestamp: REQUESTED_TIMESTAMP + 5 }],
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, {
      searchWidth: '6h',
      batchDelayMs: 0,
    }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical, getBatchHistorical },
    })
    const targets = [
      { chain: 'ethereum', token: TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP },
      { chain: 'ethereum', token: SECOND_TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP },
    ]

    await resolver.prefetch?.(targets)

    await expect(resolver(targets[0])).resolves.toMatchObject({
      priceUsd: 100,
      symbol: 'ONE',
      confidence: 0.98,
      observedTimestamp: REQUESTED_TIMESTAMP - 20,
    })
    await expect(resolver(targets[1])).resolves.toBeNull()
    expect(getBatchHistorical).toHaveBeenCalledOnce()
    expect(getBatchHistorical).toHaveBeenCalledWith({
      [`ethereum:${TOKEN}`]: [
        REQUESTED_TIMESTAMP - 21_600,
        REQUESTED_TIMESTAMP - 3_600,
        REQUESTED_TIMESTAMP,
      ],
      [`ethereum:${SECOND_TOKEN}`]: [
        REQUESTED_TIMESTAMP - 21_600,
        REQUESTED_TIMESTAMP - 3_600,
        REQUESTED_TIMESTAMP,
      ],
    }, '6h')
    expect(getHistorical).not.toHaveBeenCalled()
  })

  test('coalesces recursive market misses into a provider batch', async () => {
    const getBatchHistorical = vi.fn().mockImplementation(async (payload: Record<string, number[]>) => ({
      coins: Object.fromEntries(Object.keys(payload).map((tokenKey, index) => [tokenKey, {
        prices: [{ price: index + 1, timestamp: REQUESTED_TIMESTAMP - 10 }],
      }])),
    }))
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })

    const [first, second] = await Promise.all([
      resolver({ chain: 'ethereum', token: TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP }),
      resolver({ chain: 'ethereum', token: SECOND_TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP }),
    ])

    expect(first?.priceUsd).toBe(1)
    expect(second?.priceUsd).toBe(2)
    expect(getBatchHistorical).toHaveBeenCalledOnce()
  })

  test('retains a batch transport failure for each target retry', async () => {
    const failure = new RetryablePricingError('DeFiLlama batch HTTP 503')
    const getHistorical = vi.fn()
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: {
        getHistorical,
        getBatchHistorical: vi.fn().mockRejectedValue(failure),
      },
    })
    const targets = [
      { chain: 'ethereum', token: TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP },
      { chain: 'ethereum', token: SECOND_TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP },
    ]

    await resolver.prefetch?.(targets)

    await expect(resolver(targets[0])).rejects.toBe(failure)
    await expect(resolver(targets[1])).rejects.toBe(failure)
    expect(getHistorical).not.toHaveBeenCalled()
  })

  test('retries a transient prefetched failure from the provider on the next attempt', async () => {
    const failure = new RetryablePricingError('DeFiLlama batch HTTP 429')
    const getBatchHistorical = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'RETRIED',
            prices: [{ price: 100, timestamp: REQUESTED_TIMESTAMP - 20 }],
          },
        },
      })
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })
    const target = { chain: 'ethereum', token: TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP }

    await resolver.prefetch?.([target])
    await expect(resolver(target)).rejects.toBe(failure)

    await resolver.prefetch?.([target])
    await expect(resolver(target)).resolves.toMatchObject({
      symbol: 'RETRIED',
      priceUsd: 100,
    })
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
  })

  test('retries a transient coalesced failure from the provider on the next request', async () => {
    const failure = new RetryablePricingError('DeFiLlama batch HTTP 503')
    const getBatchHistorical = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        coins: {
          [`ethereum:${TOKEN}`]: {
            symbol: 'RETRIED',
            prices: [{ price: 100, timestamp: REQUESTED_TIMESTAMP - 20 }],
          },
        },
      })
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })
    const target = { chain: 'ethereum', token: TOKEN, requestedTimestamp: REQUESTED_TIMESTAMP }

    await expect(resolver(target)).rejects.toBe(failure)
    await expect(resolver(target)).resolves.toMatchObject({ symbol: 'RETRIED', priceUsd: 100 })
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
  })

  test('reuses strict persisted evidence before making a provider request', async () => {
    const getHistorical = vi.fn()
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([candidate()]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      priceUsd: 100,
      observedTimestamp: REQUESTED_TIMESTAMP - 60,
      adapter: 'defillama-historical',
    })
    expect(getHistorical).not.toHaveBeenCalled()
  })

  test('does not let legacy evidence seed strict resolution', async () => {
    const getHistorical = vi.fn().mockResolvedValue({
      coins: {
        [`ethereum:${TOKEN}`]: {
          price: 101,
          symbol: 'TEST',
          timestamp: REQUESTED_TIMESTAMP - 30,
          confidence: 0.95,
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '12h' }, {
      loadCandidates: vi.fn().mockResolvedValue([candidate({
        classification: 'legacy',
        quality: 'legacy',
        validationStatus: 'legacy-unvalidated',
      })]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      priceUsd: 101,
      observedTimestamp: REQUESTED_TIMESTAMP - 30,
      classification: 'observed',
      quality: 'near-eod',
      metadata: { provider: 'defillama', searchWidth: '12h' },
    })
    expect(getHistorical).toHaveBeenCalledWith(
      REQUESTED_TIMESTAMP,
      [`ethereum:${TOKEN}`],
      '12h',
    )
  })


  test('does not let persisted derived evidence bypass its recursive adapter', async () => {
    const getHistorical = vi.fn().mockResolvedValue({ coins: {} })
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([candidate({
        classification: 'derived',
        source: 'derived',
        adapter: 'erc4626-convert-to-assets',
        inputs: [{
          chain: 'ethereum',
          token: '0x0000000000000000000000000000000000000002',
          observedTimestamp: REQUESTED_TIMESTAMP - 60,
          priceUsd: 1,
          source: 'defillama',
          adapter: 'defillama-historical',
          classification: 'observed',
          quality: 'near-eod',
        }],
      })]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toBeNull()
    expect(getHistorical).toHaveBeenCalledOnce()
  })

  test('refreshes stored evidence older than the provider search window', async () => {
    const getHistorical = vi.fn().mockResolvedValue({
      coins: {
        [`ethereum:${TOKEN}`]: {
          price: 101,
          timestamp: REQUESTED_TIMESTAMP - 30,
        },
      },
    })
    const stale = candidate({
      observedTimestamp: REQUESTED_TIMESTAMP - 86_400,
      observationDistance: 86_400,
      priceUsd: 99,
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '6h' }, {
      loadCandidates: vi.fn().mockResolvedValue([stale]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({ priceUsd: 101, observedTimestamp: REQUESTED_TIMESTAMP - 30 })
    expect(getHistorical).toHaveBeenCalledOnce()
  })

  test('retains stale explicit evidence when no newer provider quote exists', async () => {
    const stale = candidate({
      observedTimestamp: REQUESTED_TIMESTAMP - 86_400,
      observationDistance: 86_400,
      priceUsd: 99,
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '6h' }, {
      loadCandidates: vi.fn().mockResolvedValue([stale]),
      defiLlama: { getHistorical: vi.fn().mockResolvedValue({ coins: {} }) },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({ priceUsd: 99, observedTimestamp: REQUESTED_TIMESTAMP - 86_400 })
  })

  test('preserves strict source disagreement as a quarantine failure', async () => {
    const resolver = createHistoricalMarketPriceResolver(pool, { disagreementThresholdBps: 1_000 }, {
      loadCandidates: vi.fn().mockResolvedValue([
        candidate({ priceUsd: 100, source: 'defillama' }),
        candidate({ priceUsd: 80, source: 'on-chain-oracle' }),
      ]),
      defiLlama: { getHistorical: vi.fn() },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).rejects.toThrow('Independent observations disagree')
  })

  test('returns unavailable when the provider has no matching coin', async () => {
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn().mockResolvedValue({ coins: {} }) },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toBeNull()
  })

  test('retries a future provider quote at an earlier timestamp', async () => {
    const getHistorical = vi.fn()
      .mockResolvedValueOnce({
        coins: {
          [`ethereum:${TOKEN}`]: {
            price: 101,
            timestamp: REQUESTED_TIMESTAMP + 4,
          },
        },
      })
      .mockResolvedValueOnce({
        coins: {
          [`ethereum:${TOKEN}`]: {
            price: 100,
            timestamp: REQUESTED_TIMESTAMP - 3_608,
          },
        },
      })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '6h' }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      observedTimestamp: REQUESTED_TIMESTAMP - 3_608,
      priceUsd: 100,
    })
    expect(getHistorical.mock.calls.map(call => call[0])).toEqual([
      REQUESTED_TIMESTAMP,
      REQUESTED_TIMESTAMP - 3_600,
    ])
  })

  test('never returns a future quote when no prior provider observation is found', async () => {
    const getHistorical = vi.fn().mockResolvedValue({
      coins: {
        [`ethereum:${TOKEN}`]: {
          price: 101,
          timestamp: REQUESTED_TIMESTAMP + 4,
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '6h' }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'ethereum',
      token: TOKEN,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toBeNull()
  })

  test('prefers a direct Optimism price over its configured CoinGecko alias', async () => {
    const directIdentifier = normalizeTokenKey('optimism', OPTIMISM_DAI)
    const getBatchHistorical = vi.fn().mockResolvedValue({
      coins: {
        [directIdentifier]: {
          symbol: 'DAI',
          prices: [{ price: 0.99, timestamp: REQUESTED_TIMESTAMP - 60 }],
        },
        'coingecko:dai': {
          symbol: 'DAI',
          prices: [{ price: 1.01, timestamp: REQUESTED_TIMESTAMP - 5 }],
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })

    await expect(resolver({
      chain: 'OPTIMISM',
      token: OPTIMISM_DAI.toLowerCase(),
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      priceUsd: 0.99,
      source: 'defillama',
      adapter: 'defillama-historical',
      classification: 'observed',
      quality: 'near-eod',
      metadata: {
        lookupKind: 'direct',
        requestedIdentifier: directIdentifier,
        matchedIdentifier: directIdentifier,
      },
    })
    expect(getBatchHistorical).toHaveBeenCalledOnce()
    expect(getBatchHistorical.mock.calls[0][0]).not.toHaveProperty('coingecko:dai')
  })

  test('uses an explicit CoinGecko alias only after a direct historical miss', async () => {
    const directIdentifier = normalizeTokenKey('optimism', OPTIMISM_DAI)
    const getBatchHistorical = vi.fn().mockResolvedValue({
      coins: {
        'coingecko:dai': {
          symbol: 'DAI',
          prices: [{ price: 1.001, timestamp: REQUESTED_TIMESTAMP - 75, confidence: 0.97 }],
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })

    await expect(resolver({
      chain: 'optimism',
      token: OPTIMISM_DAI,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      chain: 'optimism',
      token: OPTIMISM_DAI,
      requestedTimestamp: REQUESTED_TIMESTAMP,
      observedTimestamp: REQUESTED_TIMESTAMP - 75,
      priceUsd: 1.001,
      confidence: 0.97,
      source: 'defillama-coingecko-alias',
      adapter: 'defillama-coingecko-alias',
      classification: 'estimated',
      quality: 'fallback',
      metadata: {
        provider: 'defillama',
        lookupKind: 'coingecko-alias',
        requestedIdentifier: directIdentifier,
        matchedIdentifier: 'coingecko:dai',
        requestedTimestamp: REQUESTED_TIMESTAMP,
        observedTimestamp: REQUESTED_TIMESTAMP - 75,
        observationDistance: 75,
        observationOffsetSeconds: -75,
        observationDirection: 'before',
        selectionPolicy: 'latest-at-or-before-eod',
        mapping: {
          kind: 'coingecko-alias',
          requestedIdentifier: directIdentifier,
          providerIdentifier: 'coingecko:dai',
          rationale: expect.stringContaining('Optimism DAI'),
          validityInterval: {
            validFrom: null,
            validUntil: null,
            validUntilInclusive: false,
          },
        },
      },
    })
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
    expect(getBatchHistorical.mock.calls[0][0]).not.toHaveProperty('coingecko:dai')
    expect(getBatchHistorical.mock.calls[1][0]).toHaveProperty('coingecko:dai')
  })

  test('tries the alias after a direct miss when batch lookup is unavailable', async () => {
    const directIdentifier = normalizeTokenKey('optimism', OPTIMISM_DAI)
    const getHistorical = vi.fn()
      .mockResolvedValueOnce({ coins: {} })
      .mockResolvedValueOnce({
        coins: {
          'coingecko:dai': {
            price: 1.002,
            timestamp: REQUESTED_TIMESTAMP - 40,
          },
        },
      })
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'optimism',
      token: OPTIMISM_DAI,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toMatchObject({
      priceUsd: 1.002,
      source: 'defillama-coingecko-alias',
      metadata: { matchedIdentifier: 'coingecko:dai' },
    })
    expect(getHistorical.mock.calls.map(call => call[1])).toEqual([
      [directIdentifier],
      ['coingecko:dai'],
    ])
  })

  test('never uses a future alias observation for an EOD price', async () => {
    const response = {
      coins: {
        'coingecko:dai': {
          prices: [
            { price: 0.99, timestamp: REQUESTED_TIMESTAMP - 90 },
            { price: 1.01, timestamp: REQUESTED_TIMESTAMP + 30 },
          ],
        },
      },
    }
    const dependencies = {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical: vi.fn().mockResolvedValue(response) },
    }
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, dependencies)
    const target = { chain: 'optimism', token: OPTIMISM_DAI, requestedTimestamp: REQUESTED_TIMESTAMP }

    await expect(resolver(target)).resolves.toMatchObject({
      priceUsd: 0.99,
      observedTimestamp: REQUESTED_TIMESTAMP - 90,
      metadata: { observationDirection: 'before', selectionPolicy: 'latest-at-or-before-eod' },
    })
  })

  test('does not synthesize a price when both a direct identifier and its alias are empty', async () => {
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: {
        getHistorical: vi.fn(),
        getBatchHistorical: vi.fn().mockResolvedValue({ coins: {} }),
      },
    })

    await expect(resolver({
      chain: 'optimism',
      token: OPTIMISM_USDCE,
      requestedTimestamp: REQUESTED_TIMESTAMP,
    })).resolves.toBeNull()
  })

  test('deduplicates a shared alias while associating it with each requested token', async () => {
    const getBatchHistorical = vi.fn().mockResolvedValue({
      coins: {
        'coingecko:usd-coin': {
          symbol: 'USDC',
          prices: [{ price: 1.0002, timestamp: REQUESTED_TIMESTAMP - 45 }],
        },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })
    const targets = [
      { chain: 'optimism', token: OPTIMISM_USDCE, requestedTimestamp: REQUESTED_TIMESTAMP },
      { chain: 'optimism', token: OPTIMISM_USDC, requestedTimestamp: REQUESTED_TIMESTAMP },
    ]

    await resolver.prefetch?.(targets)
    const [bridged, native] = await Promise.all(targets.map(target => resolver(target)))

    expect(bridged).toMatchObject({
      token: OPTIMISM_USDCE,
      source: 'defillama-coingecko-alias',
      metadata: { matchedIdentifier: 'coingecko:usd-coin' },
    })
    expect(native).toMatchObject({
      token: OPTIMISM_USDC,
      source: 'defillama-coingecko-alias',
      metadata: { matchedIdentifier: 'coingecko:usd-coin' },
    })
    expect(getBatchHistorical).toHaveBeenCalledTimes(2)
    const [payload] = getBatchHistorical.mock.calls[1] as [Record<string, number[]>]
    expect(Object.keys(payload).filter(key => key === 'coingecko:usd-coin')).toHaveLength(1)
    expect(payload['coingecko:usd-coin']).toEqual([
      REQUESTED_TIMESTAMP - 21_600,
      REQUESTED_TIMESTAMP - 3_600,
      REQUESTED_TIMESTAMP,
    ])
  })

  test('keeps direct hits when the follow-up alias batch has a provider error', async () => {
    const failure = new RetryablePricingError('DeFiLlama alias batch HTTP 503')
    const directIdentifier = normalizeTokenKey('optimism', OPTIMISM_DAI)
    const getBatchHistorical = vi.fn()
      .mockResolvedValueOnce({
        coins: {
          [directIdentifier]: {
            prices: [{ price: 1, timestamp: REQUESTED_TIMESTAMP - 10 }],
          },
        },
      })
      .mockRejectedValueOnce(failure)
    const resolver = createHistoricalMarketPriceResolver(pool, { batchDelayMs: 0 }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn(), getBatchHistorical },
    })
    const directTarget = { chain: 'optimism', token: OPTIMISM_DAI, requestedTimestamp: REQUESTED_TIMESTAMP }
    const aliasTarget = { chain: 'optimism', token: OPTIMISM_USDCE, requestedTimestamp: REQUESTED_TIMESTAMP }

    await resolver.prefetch?.([directTarget, aliasTarget])

    await expect(resolver(directTarget)).resolves.toMatchObject({
      source: 'defillama',
      priceUsd: 1,
    })
    await expect(resolver(aliasTarget)).rejects.toBe(failure)
  })

  test('prefers direct Fantom evidence over the canonical proxy', async () => {
    const requestedTimestamp = FANTOM_PRE_INCIDENT_EOD
    const directIdentifier = normalizeTokenKey('fantom', FANTOM_USDC)
    const getHistorical = vi.fn().mockResolvedValue({
      coins: {
        [directIdentifier]: { price: 0.42, timestamp: requestedTimestamp - 10 },
        'coingecko:usd-coin': { price: 1.0001, timestamp: requestedTimestamp - 5 },
      },
    })
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp,
    })).resolves.toMatchObject({
      priceUsd: 0.42,
      source: 'defillama',
      adapter: 'defillama-historical',
      classification: 'observed',
      metadata: { lookupKind: 'direct', matchedIdentifier: directIdentifier },
    })
    expect(getHistorical).toHaveBeenCalledOnce()
  })

  test('uses the provider canonical price and complete proxy provenance before impairment', async () => {
    const requestedTimestamp = FANTOM_PRE_INCIDENT_EOD
    const observedTimestamp = requestedTimestamp - 15
    const directIdentifier = normalizeTokenKey('fantom', FANTOM_USDC)
    const getHistorical = vi.fn()
      .mockResolvedValueOnce({ coins: {} })
      .mockResolvedValueOnce({
        coins: {
          'coingecko:usd-coin': {
            price: 0.9973,
            timestamp: observedTimestamp,
            confidence: 0.96,
          },
        },
      })
    const resolver = createHistoricalMarketPriceResolver(pool, { searchWidth: '12h' }, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })

    await expect(resolver({
      chain: 'FANTOM',
      token: `0x${FANTOM_USDC.slice(2).toUpperCase()}`,
      requestedTimestamp,
    })).resolves.toMatchObject({
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp,
      observedTimestamp,
      priceUsd: 0.9973,
      source: 'defillama-canonical-market-proxy',
      adapter: 'defillama-canonical-market-proxy',
      classification: 'estimated',
      quality: 'fallback',
      metadata: {
        provider: 'defillama',
        lookupKind: 'canonical-market-proxy',
        requestedIdentifier: directIdentifier,
        matchedIdentifier: 'coingecko:usd-coin',
        observationDirection: 'before',
        observationDistance: 15,
        searchWidth: '12h',
        bridgeIssuer: 'Multichain (formerly Anyswap)',
        validityInterval: {
          validFrom: null,
          validUntil: FANTOM_USDC_BOUNDARY,
          validUntilInclusive: false,
        },
        incident: {
          id: 'multichain-fantom-2023-07',
          transactionHash: '0xbd29fe07555c28527fb0207aa0ac2b67d4afef0426793c35b76d005613477fc4',
        },
        assumption: 'pre-multichain-impairment-canonical-market-proxy',
      },
    })
    expect(getHistorical.mock.calls.map(call => call[1])).toEqual([
      [directIdentifier],
      ['coingecko:usd-coin'],
    ])
  })

  test('does not request or synthesize a canonical proxy at the impairment boundary', async () => {
    const directIdentifier = normalizeTokenKey('fantom', FANTOM_USDC)
    const getHistorical = vi.fn().mockResolvedValue({ coins: {} })
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical },
    })
    const target = {
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp: FANTOM_INCIDENT_DAY_EOD,
    }

    await expect(resolver(target)).resolves.toBeNull()
    expect(getHistorical).toHaveBeenCalledWith(FANTOM_INCIDENT_DAY_EOD, [directIdentifier], '6h')
    expect(getHistorical).toHaveBeenCalledOnce()
    expect(resolver.unavailableAttempts?.(target)).toEqual([expect.objectContaining({
      adapter: 'defillama-canonical-market-proxy',
      reason: 'unsupported',
      error: expect.stringContaining(`impairment boundary ${FANTOM_USDC_BOUNDARY}`),
    })])
  })

  test('keeps an omitted eligible canonical proxy unavailable without a zero or peg', async () => {
    const requestedTimestamp = FANTOM_PRE_INCIDENT_EOD
    const resolver = createHistoricalMarketPriceResolver(pool, {}, {
      loadCandidates: vi.fn().mockResolvedValue([]),
      defiLlama: { getHistorical: vi.fn().mockResolvedValue({ coins: {} }) },
    })
    const target = { chain: 'fantom', token: FANTOM_USDC, requestedTimestamp }

    await expect(resolver(target)).resolves.toBeNull()
    expect(resolver.unavailableAttempts?.(target)).toEqual([expect.objectContaining({
      error: expect.stringContaining('no usable positive observation'),
    })])
  })

  test('does not treat a stored proxy as an independent chain-local disagreement', async () => {
    const requestedTimestamp = FANTOM_PRE_INCIDENT_EOD
    const direct = candidate({
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp,
      observedTimestamp: requestedTimestamp - 10,
      priceUsd: 0.85,
    })
    const proxy = candidate({
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp,
      observedTimestamp: requestedTimestamp - 5,
      priceUsd: 1,
      source: 'defillama-canonical-market-proxy',
      adapter: 'defillama-canonical-market-proxy',
      classification: 'estimated',
      quality: 'fallback',
    })
    const resolver = createHistoricalMarketPriceResolver(pool, { disagreementThresholdBps: 100 }, {
      loadCandidates: vi.fn().mockResolvedValue([proxy, direct]),
      defiLlama: { getHistorical: vi.fn() },
    })

    await expect(resolver({
      chain: 'fantom',
      token: FANTOM_USDC,
      requestedTimestamp,
    })).resolves.toMatchObject({
      source: 'defillama',
      priceUsd: 0.85,
    })
  })
})
