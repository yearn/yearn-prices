import { describe, expect, it } from 'vitest'
import {
  type BackfillClient,
  type BackfillClientPool,
  FinalizationLockError,
  type FinalizationTarget,
  finalizeBackfillTargets
} from '../../src/backfill/finalize'

const TARGET: FinalizationTarget = {
  chainId: 1,
  chain: 'ethereum',
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  tokenLowercase: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  eodTimestamp: 1_704_153_599,
  resolution: { price: 1, symbol: 'USDC', confidence: null, source: 'defillama' }
}

interface FakeClient {
  statements: string[]
  released: number
}

function lockTimeoutError(): Error {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
}

function fakePool(failOnLock: number): { pool: BackfillClientPool; clients: FakeClient[] } {
  const clients: FakeClient[] = []
  let lockFailures = 0

  const pool: BackfillClientPool = {
    connect: async () => {
      const state: FakeClient = { statements: [], released: 0 }
      clients.push(state)
      const client: BackfillClient = {
        query: async (sql: string) => {
          state.statements.push(sql.trim().split('\n')[0].trim())
          if (sql.startsWith('LOCK TABLE') && lockFailures < failOnLock) {
            lockFailures += 1
            throw lockTimeoutError()
          }
          if (sql.includes('RETURNING')) {
            return { rows: [{ chain: 'ethereum', token: TARGET.token, timestamp: new Date(1_704_153_599_000) }] }
          }
          return { rows: [] }
        },
        release: () => {
          state.released += 1
        }
      }
      return client
    }
  }

  return { pool, clients }
}

describe('finalizeBackfillTargets client lifecycle', () => {
  it('uses one checked-out client per batch and commits without a trailing rollback', async () => {
    const { pool, clients } = fakePool(0)

    const outcome = await finalizeBackfillTargets(pool, [TARGET])

    expect(outcome.inserted).toBe(1)
    expect(clients).toHaveLength(1)
    expect(clients[0].released).toBe(1)
    expect(clients[0].statements[0]).toBe('BEGIN')
    expect(clients[0].statements.at(-1)).toBe('COMMIT')
    expect(clients[0].statements).not.toContain('ROLLBACK')
  })

  it('checks out a fresh client for every bounded lock retry', async () => {
    const { pool, clients } = fakePool(2)

    const outcome = await finalizeBackfillTargets(pool, [TARGET], { lockRetryLimit: 2 })

    expect(outcome.lockRetries).toBe(2)
    expect(clients).toHaveLength(3)
    expect(clients[0].statements).toContain('ROLLBACK')
    expect(clients[1].statements).toContain('ROLLBACK')
    expect(clients.every((client) => client.released === 1)).toBe(true)
  })

  it('fails visibly once the lock retry limit is exhausted', async () => {
    const { pool, clients } = fakePool(10)

    await expect(finalizeBackfillTargets(pool, [TARGET], { lockRetryLimit: 1 })).rejects.toBeInstanceOf(
      FinalizationLockError
    )
    expect(clients).toHaveLength(2)
    expect(clients.every((client) => client.released === 1)).toBe(true)
  })

  it('rejects an invalid timeout literal before opening a transaction', async () => {
    const { pool, clients } = fakePool(0)

    await expect(
      finalizeBackfillTargets(pool, [TARGET], { lockTimeout: "5s'; DROP TABLE token_prices --" })
    ).rejects.toThrow('Invalid transaction timeout literal')
    expect(clients).toHaveLength(0)
  })

  it('releases the client with the rollback error when ROLLBACK itself fails', async () => {
    const releaseCalls: unknown[] = []
    const originalError = new Error('boom')
    const rollbackError = new Error('rollback failed')

    const pool: BackfillClientPool = {
      connect: async () => {
        const client: BackfillClient = {
          query: async (sql: string) => {
            if (sql.startsWith('LOCK TABLE')) {
              throw originalError
            }
            if (sql.startsWith('ROLLBACK')) {
              throw rollbackError
            }
            return { rows: [] }
          },
          release: (error?: unknown) => {
            releaseCalls.push(error)
          }
        }
        return client
      }
    }

    await expect(finalizeBackfillTargets(pool, [TARGET])).rejects.toBe(originalError)
    expect(releaseCalls).toEqual([rollbackError])
  })

  it('opens no transaction in dry-run mode', async () => {
    const { pool, clients } = fakePool(0)

    const outcome = await finalizeBackfillTargets(pool, [TARGET], { dryRun: true })

    expect(outcome.inserted).toBe(1)
    expect(clients).toHaveLength(1)
    expect(clients[0].statements).not.toContain('BEGIN')
    expect(clients[0].statements.some((statement) => statement.startsWith('LOCK TABLE'))).toBe(false)
    expect(clients[0].released).toBe(1)
  })
})
