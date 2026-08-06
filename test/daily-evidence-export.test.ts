import { describe, expect, test } from 'vitest'
import { buildDailyEvidenceExport } from '../src/daily-evidence-export'

const EOD = 1_785_887_999

describe('daily evidence export', () => {
  test('is deterministic, ordered, and distinguishes terminal outcomes', () => {
    const targets = [
      {
        chain: 'hyperevm', token: '0xB8', eod_at: new Date(EOD * 1000), status: 'priced',
        adapter: 'defillama-historical', failure_class: null, failure_reason: null,
        metadata: {
          chainId: 999,
          candidateId: 'market',
          roles: ['vault-asset'],
          consumerSupport: 'supported',
          producerSupport: { status: 'unsupported', reason: 'unsupported-chain', chainName: null },
        },
      },
      {
        chain: 'ethereum', token: '0xA1', eod_at: new Date(EOD * 1000), status: 'unsupported',
        adapter: null, failure_class: 'unsupported', failure_reason: 'no evidence', metadata: {},
      },
      {
        chain: 'ethereum', token: '0xA0', eod_at: new Date(EOD * 1000), status: 'quarantined',
        adapter: 'candidate-selection', failure_class: 'disagreement', failure_reason: 'conflict', metadata: {},
      },
    ]
    const candidates = [{
      chain: 'hyperevm', token: '0xB8', timestamp: new Date(EOD * 1000), price: '0.999',
      symbol: 'USDC', confidence: '0.99', source: 'defillama', candidate_id: 'market',
      observed_at: new Date((EOD - 1) * 1000), evidence_kind: 'observed', quality: 'near-eod',
      adapter: 'defillama-historical', block_number: null, input_evidence: [],
      validation_status: 'validated', failure_reason: null,
    }]

    const result = buildDailyEvidenceExport(EOD, targets, candidates)

    expect(result.outcomes).toEqual({ priced: 1, unavailable: 1, quarantined: 1 })
    expect(result.targets.map(target => target.token)).toEqual(['0xa0', '0xa1', '0xb8'])
    expect(result.targets[2]).toMatchObject({
      chainId: 999,
      source: 'defillama',
      classification: 'observed',
      quality: 'near-eod',
      validationState: 'validated',
      inventory: {
        consumerSupport: 'supported',
        producerSupport: { status: 'unsupported', reason: 'unsupported-chain', chainName: null },
      },
    })
    expect(JSON.stringify(result)).toBe(JSON.stringify(buildDailyEvidenceExport(EOD, targets, candidates)))
  })
})
