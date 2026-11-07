import { driverQuery } from '../helpers/drizzle-driver'
import { describe, expect, it, vi } from 'vitest'
import { discoverRepairTargets } from '../../scripts/lib/historical-repair'
import { classifyRepairFailure, isExpectedUnresolved } from '../../scripts/repair-historical-prices'
import type { RepairQueueDb } from '../../src/db/repair-queue'
import { normalizeTokenAddress } from '../../src/utils/chains'
import { currentUtcDayEnd, nowUnix } from '../../src/utils/time'

const ROOT = '0x0000000000000000000000000000000000000001'
const EXTRA = '0xabcd000000000000000000000000000000000000'

function dbFor(results: Array<{ rows: unknown[] }>) {
  const query = driverQuery(vi.fn(async (_sql: string, _params?: unknown[]) => results.shift() ?? { rows: [] }))
  return { db: { query } as unknown as RepairQueueDb, query }
}

describe('historical repair discovery', () => {
  it('includes non-root provisional rows and only requests recent closed days', async () => {
    const previousDay = currentUtcDayEnd(nowUnix()) - 86_400
    const { db, query } = dbFor([
      {
        rows: [{ chain_id: '1', chain: 'ethereum', token: EXTRA, timestamp: new Date(previousDay * 1000) }]
      },
      { rows: [] },
      { rows: [] }
    ])

    const result = await discoverRepairTargets(db, [{ chainId: 1, token: ROOT, timestamp: previousDay }], 2)

    expect(result.provisionalSelected).toBe(1)
    expect(result.targets).toContainEqual({ chainId: 1, token: normalizeTokenAddress(EXTRA), timestamp: previousDay })
    expect(result.targets.every((target) => target.timestamp < currentUtcDayEnd(nowUnix()))).toBe(true)
    expect(result.targets.every((target) => target.timestamp % 86_400 === 86_399)).toBe(true)
    expect(String(query.mock.calls[0][0])).toContain('p.finalized = FALSE')
    expect(String(query.mock.calls[0][0])).toContain('historical_price_repair_queue')
  })

  it('skips a misaligned provisional row instead of aborting discovery', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const previousDay = currentUtcDayEnd(nowUnix()) - 86_400
    const { db } = dbFor([
      {
        rows: [
          { chain_id: '1', chain: 'ethereum', token: EXTRA, timestamp: new Date((previousDay - 7_200) * 1000) },
          { chain_id: '1', chain: 'ethereum', token: EXTRA, timestamp: new Date(previousDay * 1000) }
        ]
      },
      { rows: [] },
      { rows: [] }
    ])

    const result = await discoverRepairTargets(db, [], 1)

    expect(result.misalignedSkipped).toBe(1)
    expect(result.targets).toEqual([{ chainId: 1, token: normalizeTokenAddress(EXTRA), timestamp: previousDay }])
  })

  it('removes targets already covered by an accepted finalized observation', async () => {
    const previousDay = currentUtcDayEnd(nowUnix()) - 86_400
    const { db } = dbFor([
      { rows: [] },
      { rows: [] },
      { rows: [{ chain_id: 1, token: ROOT.toLowerCase(), timestamp: new Date(previousDay * 1000) }] }
    ])

    const result = await discoverRepairTargets(db, [{ chainId: 1, token: ROOT, timestamp: previousDay }], 1)

    expect(result.finalized).toBe(1)
    expect(result.targets).toEqual([])
  })

  it('normalizes inventory bigint chain ids and token casing', async () => {
    const previousDay = currentUtcDayEnd(nowUnix()) - 86_400
    const { db } = dbFor([
      { rows: [] },
      {
        rows: [
          {
            chain_id: '1',
            chain: 'ethereum',
            token: EXTRA,
            timestamp: new Date(previousDay * 1000)
          }
        ]
      },
      { rows: [] }
    ])

    const result = await discoverRepairTargets(db, [{ chainId: 1, token: ROOT, timestamp: previousDay }], 1)

    expect(result.inventorySelected).toBe(1)
    expect(result.targets).toContainEqual({ chainId: 1, token: normalizeTokenAddress(EXTRA), timestamp: previousDay })
  })
})

describe('historical repair failure classification', () => {
  it('retries absent and exception-like evidence', () => {
    expect(classifyRepairFailure(undefined)).toBe('retryable')
    expect(classifyRepairFailure({ type: 'fatal', reason: 'provider unavailable' })).toBe('retryable')
  })

  it('treats explicit unsupported outcomes as missing', () => {
    expect(classifyRepairFailure({ type: 'target-outcome', status: 'unresolved', reason: 'unsupported adapter' })).toBe(
      'missing'
    )
  })

  it('keeps cycle and budget failures retryable without treating them as worker errors', () => {
    expect(classifyRepairFailure({ type: 'target-outcome', status: 'unresolved', reason: 'cycle' })).toBe('retryable')
    expect(classifyRepairFailure({ type: 'target-outcome', status: 'unresolved', reason: 'budget exhausted' })).toBe(
      'retryable'
    )
    expect(isExpectedUnresolved({ type: 'target-outcome', status: 'unresolved', reason: 'cycle' })).toBe(true)
    expect(isExpectedUnresolved({ type: 'target-outcome', status: 'unresolved', reason: 'max-depth' })).toBe(true)
    expect(isExpectedUnresolved({ type: 'target-outcome', status: 'unresolved', reason: 'budget' })).toBe(true)
    expect(isExpectedUnresolved({ type: 'target-outcome', status: 'unresolved', reason: 'provider unavailable' })).toBe(
      false
    )
  })

  it('marks rejected outcomes invalid', () => {
    expect(classifyRepairFailure({ type: 'target-outcome', status: 'rejected', reason: 'implausible' })).toBe('invalid')
    expect(classifyRepairFailure({ type: 'target-outcome', status: 'rejected_implausible' })).toBe('invalid')
  })
})
