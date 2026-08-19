import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type BackfillPool,
  type BackfillReport,
  type ChartFetch,
  ChartRequestError,
  checkpointPath,
  groupContiguousRanges,
  runBackfill
} from '../../scripts/backfill-historical-gaps'

const DAY = 86_400
const EOD = 1_704_153_599
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const OPTIMISM_DAI = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'backfill-gaps-'))
})

function manifestFile(targets: Array<{ chainId: number; token: string; eodTimestamp: number }>): string {
  const path = join(directory, 'manifest.json')
  writeFileSync(path, JSON.stringify({ version: 1, targets }))
  return path
}

interface FakePoolConfig {
  pricedRows?: Array<{ chain: string; token: string; eodTimestamp: number }>
  noncanonical?: Array<{ chain: string; token: string }>
  failBeginOnCall?: number
  lockUnavailable?: boolean
}

function fakePool(config: FakePoolConfig = {}): { pool: BackfillPool; statements: string[] } {
  const statements: string[] = []
  let beginCalls = 0

  const query = async (sql: string, params?: unknown[]) => {
    statements.push(sql.trim().split('\n')[0].trim())

    if (sql.startsWith('BEGIN')) {
      beginCalls += 1
      if (config.failBeginOnCall === beginCalls) {
        throw new Error('connection lost')
      }
    }
    if (config.lockUnavailable && sql.startsWith('LOCK TABLE')) {
      throw Object.assign(new Error('could not obtain lock'), { code: '55P03' })
    }

    if (sql.includes('lower(tp.token)')) {
      return { rows: (config.noncanonical ?? []) as unknown as Record<string, unknown>[] }
    }
    if (sql.includes('WITH requested')) {
      return {
        rows: (config.pricedRows ?? []).map((row) => ({
          chain: row.chain,
          token: row.token,
          timestamp: new Date(row.eodTimestamp * 1000),
          price: 1,
          symbol: null,
          confidence: null,
          source: 'defillama'
        }))
      }
    }
    if (sql.includes('RETURNING')) {
      const rows: Record<string, unknown>[] = []
      for (let offset = 0; offset < (params ?? []).length; offset += 7) {
        const all = params as unknown[]
        rows.push({
          chain: all[offset],
          token: all[offset + 1],
          timestamp: new Date(all[offset + 2] as string)
        })
      }
      return { rows }
    }
    return { rows: [] }
  }

  const pool = {
    query,
    connect: async () => ({ query, release: () => {} })
  } as unknown as BackfillPool

  return { pool, statements }
}

function chart(points: Array<{ timestamp: number; price: number }>, symbol = 'USDC') {
  return { symbol, confidence: 0.99, decimals: 6, prices: points }
}

function fetchChartFrom(coins: Record<string, unknown>): ChartFetch {
  return async (identifier) => {
    const coin = coins[identifier]
    if (coin instanceof Error) {
      throw coin
    }
    return { coin, attempts: 1 }
  }
}

function readReport(path: string): BackfillReport {
  return JSON.parse(readFileSync(path, 'utf8')) as BackfillReport
}

describe('groupContiguousRanges', () => {
  it('splits noncontiguous days and caps the span', () => {
    const target = (eodTimestamp: number) => ({
      chainId: 1,
      chain: 'ethereum',
      token: USDC as `0x${string}`,
      tokenLowercase: USDC.toLowerCase(),
      eodTimestamp
    })

    const ranges = groupContiguousRanges([target(EOD + 2 * DAY), target(EOD), target(EOD + DAY)], () => 'coin', 2)

    expect(ranges.map((range) => [range.rangeStart, range.rangeEnd])).toEqual([
      [EOD, EOD + DAY],
      [EOD + 2 * DAY, EOD + 2 * DAY]
    ])
  })
})

describe('runBackfill', () => {
  it('reports a dry run as projected and performs no writes', async () => {
    const manifestPath = manifestFile([
      { chainId: 1, token: USDC, eodTimestamp: EOD },
      { chainId: 1, token: USDC, eodTimestamp: EOD + DAY }
    ])
    const reportPath = join(directory, 'report.json')
    const { pool, statements } = fakePool({
      pricedRows: [{ chain: 'ethereum', token: USDC, eodTimestamp: EOD }]
    })

    const result = await runBackfill(
      { manifestPath, reportPath, write: false },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: chart([{ timestamp: EOD + DAY + 120, price: 1.0012 }])
        })
      }
    )

    expect(result.exitCode).toBe(0)
    const report = readReport(reportPath)
    expect(report.mode).toBe('dry-run')
    expect(report.summary).toMatchObject({
      requested: 2,
      normalizedUniqueTargets: 2,
      alreadyPriced: 1,
      resolvedByDirectProvider: 1,
      unresolved: 0,
      inserted: 0,
      projectedInserted: 1
    })
    expect(report.targets.find((record) => record.eodTimestamp === EOD)?.status).toBe('skipped_existing')
    const projectedRecord = report.targets.find((record) => record.eodTimestamp === EOD + DAY)
    expect(projectedRecord).toMatchObject({
      status: 'inserted',
      projected: true,
      method: 'defillama-direct',
      providerIdentifier: `ethereum:${USDC.toLowerCase()}`,
      observedTimestamp: EOD + DAY + 120,
      offsetSeconds: 120,
      source: 'defillama',
      attempts: 1
    })
    expect(statements.some((statement) => statement.startsWith('BEGIN'))).toBe(false)
    expect(statements.some((statement) => statement.startsWith('INSERT'))).toBe(false)
    expect(statements.some((statement) => statement.startsWith('DELETE'))).toBe(false)
  })

  it('inserts in write mode and clears stale inventory for already priced targets', async () => {
    const manifestPath = manifestFile([
      { chainId: 1, token: USDC, eodTimestamp: EOD },
      { chainId: 1, token: USDC, eodTimestamp: EOD + DAY }
    ])
    const reportPath = join(directory, 'report.json')
    const { pool, statements } = fakePool({
      pricedRows: [{ chain: 'ethereum', token: USDC, eodTimestamp: EOD }]
    })

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: chart([{ timestamp: EOD + DAY - 30, price: 1.0 }])
        })
      }
    )

    expect(result.exitCode).toBe(0)
    const report = readReport(reportPath)
    expect(report.mode).toBe('write')
    expect(report.summary).toMatchObject({ inserted: 1, projectedInserted: 0, unresolved: 0 })
    expect(report.targets.every((record) => record.projected === undefined)).toBe(true)
    expect(statements).toContain('BEGIN')
    expect(statements).toContain('COMMIT')
    expect(statements.filter((statement) => statement.startsWith('DELETE')).length).toBeGreaterThan(0)
  })

  it('falls back to a reviewed alias only after a direct miss', async () => {
    const manifestPath = manifestFile([{ chainId: 10, token: OPTIMISM_DAI, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool()

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`optimism:${OPTIMISM_DAI.toLowerCase()}`]: chart([], 'DAI'),
          'coingecko:dai': chart([{ timestamp: EOD - 45, price: 0.999 }], 'DAI')
        })
      }
    )

    expect(result.exitCode).toBe(0)
    const report = readReport(reportPath)
    expect(report.summary).toMatchObject({
      resolvedByDirectProvider: 0,
      resolvedByReviewedAlias: 1,
      inserted: 1
    })
    expect(report.targets[0]).toMatchObject({
      status: 'inserted',
      method: 'defillama-alias',
      providerIdentifier: 'coingecko:dai',
      source: 'defillama-alias',
      diagnosticCodes: ['not_found'],
      attempts: 2
    })
    expect(report.targets[0].methods).toEqual([
      {
        method: 'defillama-direct',
        providerIdentifier: `optimism:${OPTIMISM_DAI.toLowerCase()}`,
        attempts: 1,
        diagnosticCodes: ['not_found']
      },
      {
        method: 'defillama-alias',
        providerIdentifier: 'coingecko:dai',
        attempts: 1,
        diagnosticCodes: []
      }
    ])
  })

  it('classifies a malformed provider envelope as an invalid response', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool()

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      { pool, fetchChart: async () => ({ coin: undefined, attempts: 1, malformed: true }) }
    )

    expect(result.exitCode).toBe(2)
    const report = readReport(reportPath)
    expect(report.summary).toMatchObject({ invalidProviderResponses: 1, providerRetryFailures: 0, unresolved: 1 })
    expect(report.targets[0]).toMatchObject({
      status: 'unresolved',
      diagnosticCodes: ['invalid_response', 'not_applicable']
    })
    expect(report.targets[0].methods).toEqual([
      {
        method: 'defillama-direct',
        providerIdentifier: `ethereum:${USDC.toLowerCase()}`,
        attempts: 1,
        diagnosticCodes: ['invalid_response']
      }
    ])
  })

  it('counts retries spent by a request that exhausts every attempt', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool()

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: new ChartRequestError(3, ['retry_exhausted'])
        })
      }
    )

    expect(result.exitCode).toBe(2)
    expect(readReport(reportPath).request).toMatchObject({ chartRequests: 1, retries: 2, requestFailures: 1 })
  })

  it('counts finalization lock failures before emitting the fatal report', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool({ lockUnavailable: true })

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: chart([{ timestamp: EOD, price: 1 }])
        })
      }
    )

    expect(result.exitCode).toBe(1)
    const report = readReport(reportPath)
    expect(report.summary.finalizationLockFailures).toBe(4)
    expect(report.fatal?.message).toContain('lock')
  })

  it('checkpoints an unfinished run without marking it finished', async () => {
    const manifestPath = manifestFile([
      { chainId: 1, token: USDC, eodTimestamp: EOD },
      { chainId: 1, token: USDC, eodTimestamp: EOD + DAY }
    ])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool({ failBeginOnCall: 2 })

    const result = await runBackfill(
      { manifestPath, reportPath, write: true, batchSize: 1 },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: chart([
            { timestamp: EOD, price: 1 },
            { timestamp: EOD + DAY, price: 1.1 }
          ])
        })
      }
    )

    expect(result.exitCode).toBe(1)

    const checkpoint = readReport(checkpointPath(reportPath))
    expect(checkpoint.finishedAt).toBeNull()
    expect(checkpoint.summary).toMatchObject({ inserted: 1, pending: 1, unresolved: 0 })
    expect(checkpoint.targets.filter((record) => record.status === 'pending')).toHaveLength(1)

    const report = readReport(reportPath)
    expect(report.finishedAt).not.toBeNull()
    expect(report.summary).toMatchObject({ pending: 0, unresolved: 1 })
    expect(report.fatal).toMatchObject({ committedTargets: 1, failedTargets: 1 })
    expect(existsSync(`${reportPath}.tmp`)).toBe(false)
    expect(existsSync(`${checkpointPath(reportPath)}.tmp`)).toBe(false)
  })

  it('checkpoints straight after clearing inventory for already priced targets', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool({ pricedRows: [{ chain: 'ethereum', token: USDC, eodTimestamp: EOD }] })

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      { pool, fetchChart: fetchChartFrom({}) }
    )

    expect(result.exitCode).toBe(0)
    const checkpoint = readReport(checkpointPath(reportPath))
    expect(checkpoint.finishedAt).toBeNull()
    expect(checkpoint.targets[0].status).toBe('skipped_existing')
  })

  it('exits 2 when a target stays unresolved and records the failure diagnostics', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool()

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: fetchChartFrom({
          [`ethereum:${USDC.toLowerCase()}`]: new ChartRequestError(3, ['retry_exhausted', 'timeout'])
        })
      }
    )

    expect(result.exitCode).toBe(2)
    const report = readReport(reportPath)
    expect(report.summary).toMatchObject({
      unresolved: 1,
      providerRetryFailures: 1,
      inserted: 0
    })
    expect(report.targets[0]).toMatchObject({
      status: 'unresolved',
      method: null,
      attempts: 3,
      diagnosticCodes: ['retry_exhausted', 'timeout', 'not_applicable']
    })
  })

  it('exits 1 with a fatal report when the manifest is invalid', async () => {
    const manifestPath = join(directory, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ version: 1, targets: [{ chainId: 1, token: USDC, eodTimestamp: 1 }] }))
    const reportPath = join(directory, 'report.json')
    const { pool } = fakePool()

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      { pool, fetchChart: fetchChartFrom({}) }
    )

    expect(result.exitCode).toBe(1)
    expect(readReport(reportPath).fatal?.message).toContain('not an exact UTC end of day')
  })

  it('exits 1 before provider work when token_prices holds a noncanonical casing', async () => {
    const manifestPath = manifestFile([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const reportPath = join(directory, 'report.json')
    const { pool, statements } = fakePool({
      noncanonical: [{ chain: 'ethereum', token: USDC.toLowerCase() }]
    })
    let chartCalls = 0

    const result = await runBackfill(
      { manifestPath, reportPath, write: true },
      {
        pool,
        fetchChart: async () => {
          chartCalls += 1
          return { coin: undefined, attempts: 1 }
        }
      }
    )

    expect(result.exitCode).toBe(1)
    expect(chartCalls).toBe(0)
    expect(statements.some((statement) => statement.startsWith('BEGIN'))).toBe(false)
    const report = readReport(reportPath)
    expect(report.fatal?.message).toContain('noncanonical token casings')
    expect(report.fatal).toMatchObject({ committedTargets: 0, failedTargets: 0, unattemptedTargets: 1 })
    expect(existsSync(reportPath)).toBe(true)
  })
})
