import { describe, expect, it } from 'vitest'
import {
  classifyProductionPrice,
  parseProductionEodSnapshotLine,
  productionDailyTarget,
  productionPriceWrite,
  type ProductionEodManifest,
  validateProductionEodSnapshot,
} from '../src/production-snapshot'

const TOKEN = '0x0000000000000000000000000000000000000001'
const EOD = 1_704_153_599
const manifest: ProductionEodManifest = {
  schemaVersion: 1,
  kind: 'manifest',
  generatedAt: '2026-08-02T00:00:00.000Z',
  endpoint: 'https://prices.yearn.dev',
  eventCount: 2,
  targetCount: 2,
  targetCountByChain: { ethereum: 2 },
}

function priceLine(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'price',
    chainId: 1,
    chain: 'ethereum',
    token: TOKEN,
    timestamp: EOD,
    price: 2,
    symbol: 'TOKEN',
    confidence: 0.9,
    source: 'defillama',
    acceptedForLocalSeed: true,
    rejectionReason: null,
    ...overrides,
  })
}

describe('production EOD snapshot', () => {
  it('accepts structurally valid trusted observations without claiming independent validation', () => {
    const record = parseProductionEodSnapshotLine(priceLine(), 2)
    if (record.kind !== 'price') throw new Error('expected price')

    expect(classifyProductionPrice(record)).toEqual({
      classification: 'trusted-production-observation-structural',
      accepted: true,
      reason: null,
    })
    expect(productionPriceWrite(record, manifest)).toMatchObject({
      timestamp: EOD,
      price: 2,
      source: 'defillama',
      classification: 'legacy',
      quality: 'legacy',
      validationStatus: 'validated',
      adapter: 'production-yearn-prices-import',
      metadata: {
        origin: 'production-yearn-prices',
        importClassification: 'trusted-production-observation-structural',
        observedTimestampKnown: false,
        independentlyValidated: false,
      },
    })
    expect(productionDailyTarget(record, manifest)).toMatchObject({
      eodTimestamp: EOD,
      metadata: { importAccepted: true, source: 'defillama' },
    })
  })

  it('preserves stable pegs as ineligible legacy evidence and queues independent repair', () => {
    const record = parseProductionEodSnapshotLine(priceLine({
      price: 1,
      source: 'stable-peg',
      acceptedForLocalSeed: true,
    }), 2)
    if (record.kind !== 'price') throw new Error('expected price')

    expect(classifyProductionPrice(record)).toMatchObject({
      classification: 'automatic-peg-repair',
      accepted: false,
    })
    expect(productionPriceWrite(record, manifest)).toMatchObject({
      price: 1,
      source: 'stable-peg',
      validationStatus: 'legacy-unvalidated',
      metadata: { upstreamSource: 'stable-peg' },
    })
    expect(productionDailyTarget(record, manifest)).toMatchObject({
      metadata: { importAccepted: false, importClassification: 'automatic-peg-repair' },
    })
  })

  it.each(['curve', 'derived', 'defillama-coingecko-alias', 'defillama-canonical-market-proxy']) (
    'requires independent validation for %s rows without complete imported provenance',
    source => {
      const record = parseProductionEodSnapshotLine(priceLine({ source }), 2)
      if (record.kind !== 'price') throw new Error('expected price')

      expect(classifyProductionPrice(record)).toMatchObject({
        classification: 'requires-independent-validation',
        accepted: false,
      })
      expect(productionPriceWrite(record, manifest).validationStatus).toBe('legacy-unvalidated')
    },
  )

  it('rejects intraday rows and invalid non-positive prices', () => {
    expect(() => parseProductionEodSnapshotLine(priceLine({ timestamp: EOD - 1 }), 2))
      .toThrow('not an exact UTC day-end')
    expect(() => parseProductionEodSnapshotLine(priceLine({ price: 0 }), 2))
      .toThrow('invalid price record')
  })

  it('rejects mismatched chain IDs, duplicates, and manifest chain-count mismatches', () => {
    expect(() => parseProductionEodSnapshotLine(priceLine({ chainId: 10 }), 2))
      .toThrow('mismatched chain name and ID')

    const target = parseProductionEodSnapshotLine(JSON.stringify({
      schemaVersion: 1,
      kind: 'missing',
      chainId: 1,
      chain: 'ethereum',
      token: TOKEN,
      timestamp: EOD,
      reason: 'not-returned',
    }), 2)
    expect(() => validateProductionEodSnapshot([
      { ...manifest, targetCount: 2, targetCountByChain: { ethereum: 2 } },
      target,
      target,
    ])).toThrow('duplicate target')
    expect(() => validateProductionEodSnapshot([
      { ...manifest, targetCount: 1, targetCountByChain: { ethereum: 0, optimism: 1 } },
      target,
    ])).toThrow('does not match records for ethereum')
  })
})
