import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aliasEligibilityOf,
  buildReport,
  captureRanges,
  chartClient,
  classifyDirection,
  hasEqualDistanceTie,
  matchChartResponse,
  parseArgs,
  percentile,
  summarizeRangeResponse,
  toCsv
} from '../../scripts/replay-historical-gaps'
import { type NormalizedTarget, parseManifest } from '../../src/backfill/manifest'
import { groupContiguousRanges } from '../../src/backfill/ranges'
import { SharedCooldownRateLimiter } from '../../src/clients/http-client'
import { getDefiLlamaCoinGeckoAlias } from '../../src/sources/defillama/aliases'
import { DEFI_LLAMA_TOKEN_BATCH } from '../../src/sources/defillama/batch'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const DAY_SECONDS = 86_400
const BASE_EOD = 1_704_153_599

function target(chain: string, token: string, dayOffset: number): NormalizedTarget {
  const eodTimestamp = BASE_EOD + dayOffset * DAY_SECONDS
  return {
    chainId: 1,
    chain,
    token: token as `0x${string}`,
    tokenLowercase: token.toLowerCase(),
    eodTimestamp
  }
}

function identifierOf(item: { target: NormalizedTarget }): string {
  return `${item.target.chain}:${item.target.tokenLowercase}`
}

function eodOf(item: { target: NormalizedTarget }): number {
  return item.target.eodTimestamp
}

it('keeps sibling replay chart calls behind the full shared Retry-After cooldown', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '120' } }))
    .mockImplementation(async () => Response.json({ coins: {} }))
  vi.stubGlobal('fetch', fetchMock)
  const limiter = new SharedCooldownRateLimiter(10, 1000)
  const first = chartClient(limiter, () => {}).getChart(['ethereum:0xa'], { start: BASE_EOD, period: '1d' })
  await vi.advanceTimersByTimeAsync(0)
  const second = chartClient(limiter, () => {}).getChart(['ethereum:0xb'], { start: BASE_EOD, period: '1d' })

  await vi.advanceTimersByTimeAsync(119_999)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([first, second])
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('coalesces same-range replay identifiers in conservative chart batches and keeps per-range records', async () => {
  const ranges = Array.from({ length: DEFI_LLAMA_TOKEN_BATCH + 1 }, (_, index) => {
    const token = `0x${(index + 1).toString(16)}`
    return {
      identifier: `ethereum:${token}`,
      rangeStart: BASE_EOD,
      rangeEnd: BASE_EOD,
      items: [{ cohort: 'gap' as const, target: target('ethereum', token, 0) }]
    }
  })
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input.toString())
    const identifiers = url.pathname.split('/chart/')[1].split(',')
    return Response.json({
      coins: Object.fromEntries(
        identifiers.map((identifier) => [identifier, chart([{ timestamp: BASE_EOD, price: 2 }])])
      )
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const stats = { apiCalls: 0, retries: 0, requestFailures: 0 }
  const captureRecords: unknown[] = []
  const requestRecords: unknown[] = []

  const results = await captureRanges(
    { label: '6h', searchWidth: '6h', offsetSeconds: 21_600 },
    'direct',
    ranges,
    () => undefined,
    new SharedCooldownRateLimiter(10, 1000),
    stats,
    new Map(),
    captureRecords as never,
    requestRecords as never
  )

  const identifierCounts = fetchMock.mock.calls.map(
    ([input]) => new URL(input.toString()).pathname.split('/chart/')[1].split(',').length
  )
  expect(identifierCounts.sort()).toEqual([1, DEFI_LLAMA_TOKEN_BATCH])
  expect(stats).toMatchObject({ apiCalls: 2, retries: 0, requestFailures: 0 })
  expect(results.size).toBe(ranges.length)
  expect([...results.values()]).toEqual(
    Array.from({ length: ranges.length }, () => expect.objectContaining({ kind: 'matched' }))
  )
  expect(captureRecords).toHaveLength(ranges.length)
  expect(requestRecords).toHaveLength(ranges.length)
})

describe('groupContiguousRanges', () => {
  it('merges consecutive days for the same identifier into one range', () => {
    const items = [
      { cohort: 'gap' as const, target: target('ethereum', '0xA', 0) },
      { cohort: 'gap' as const, target: target('ethereum', '0xA', 1) },
      { cohort: 'gap' as const, target: target('ethereum', '0xA', 2) }
    ]

    const ranges = groupContiguousRanges(items, identifierOf, eodOf, 365)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].rangeStart).toBe(BASE_EOD)
    expect(ranges[0].rangeEnd).toBe(BASE_EOD + 2 * DAY_SECONDS)
    expect(ranges[0].items).toHaveLength(3)
  })

  it('splits a gap in the day sequence into separate ranges', () => {
    const items = [
      { cohort: 'gap' as const, target: target('ethereum', '0xA', 0) },
      { cohort: 'gap' as const, target: target('ethereum', '0xA', 5) }
    ]

    const ranges = groupContiguousRanges(items, identifierOf, eodOf, 365)
    expect(ranges).toHaveLength(2)
  })

  it('groups by identifier independently, one range per token', () => {
    const items = [
      { cohort: 'control' as const, target: target('ethereum', '0xA', 0) },
      { cohort: 'gap' as const, target: target('ethereum', '0xB', 0) }
    ]

    const ranges = groupContiguousRanges(items, identifierOf, eodOf, 365)
    expect(ranges).toHaveLength(2)
    expect(new Set(ranges.map((range) => range.identifier))).toEqual(new Set(['ethereum:0xa', 'ethereum:0xb']))
  })

  it('splits a run once it exceeds the maximum span', () => {
    const items = [0, 1, 2].map((offset) => ({ cohort: 'gap' as const, target: target('ethereum', '0xA', offset) }))
    const ranges = groupContiguousRanges(items, identifierOf, eodOf, 2)
    expect(ranges).toHaveLength(2)
    expect(ranges[0].items).toHaveLength(2)
    expect(ranges[1].items).toHaveLength(1)
  })
})

describe('parseArgs', () => {
  const required = [
    '--control-manifest',
    'control.json',
    '--gap-manifest',
    'gap.json',
    '--report',
    'report.json',
    '--csv',
    'capture.csv'
  ]

  it('names a database URL environment variable instead of taking the credential on argv', () => {
    expect(parseArgs([...required, '--database-url-env', 'REPLAY_DATABASE_URL'])).toMatchObject({
      controlManifestPath: 'control.json',
      csvPath: 'capture.csv',
      databaseUrlEnv: 'REPLAY_DATABASE_URL'
    })
  })

  it('rejects a connection string on argv', () => {
    expect(() => parseArgs([...required, '--database-url', 'postgres://user:secret@host/db'])).toThrow(
      'unrecognized option: --database-url'
    )
  })

  it('rejects an unknown option and a stray positional argument', () => {
    expect(() => parseArgs([...required, '--nope', 'x'])).toThrow('unrecognized option: --nope')
    expect(() => parseArgs([...required, 'write'])).toThrow('unrecognized argument: write')
  })

  it('keeps the default windows and rejects an unsupported one', () => {
    expect(parseArgs(required).windows.map((window) => window.label)).toEqual(['1h', '2h', '6h'])
    expect(parseArgs([...required, '--windows', '2h,6h']).windows.map((window) => window.label)).toEqual(['2h', '6h'])
    expect(() => parseArgs([...required, '--windows', '12h'])).toThrow('unsupported --windows value')
  })
})

describe('classifyDirection', () => {
  it('classifies zero, negative, and positive offsets', () => {
    expect(classifyDirection(0)).toBe('exact')
    expect(classifyDirection(-30)).toBe('before')
    expect(classifyDirection(30)).toBe('after')
  })
})

describe('percentile', () => {
  it('returns null for an empty array', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('returns the median and p90 of a sorted array', () => {
    const sorted = [1, 2, 3, 4, 5]
    expect(percentile(sorted, 0.5)).toBe(3)
    expect(percentile(sorted, 0.9)).toBe(5)
  })
})

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WINDOWS = [
  { label: '1h', searchWidth: '1h', offsetSeconds: 3_600 },
  { label: '6h', searchWidth: '6h', offsetSeconds: 21_600 }
]

function chart(points: Array<{ timestamp: number; price: number }>) {
  return { symbol: 'USDC', confidence: 0.99, decimals: 6, prices: points }
}

describe('matchChartResponse', () => {
  it('classifies a malformed envelope as an invalid response', () => {
    expect(matchChartResponse({}, 'ethereum:0xa', BASE_EOD, { maximumOffsetSeconds: 3_600 })).toEqual({
      kind: 'invalid_response'
    })
    expect(matchChartResponse({ coins: [] }, 'ethereum:0xa', BASE_EOD, { maximumOffsetSeconds: 3_600 })).toEqual({
      kind: 'invalid_response'
    })
  })

  it('classifies an absent identifier as a legitimate miss', () => {
    expect(matchChartResponse({ coins: {} }, 'ethereum:0xa', BASE_EOD, { maximumOffsetSeconds: 3_600 })).toEqual({
      kind: 'not_found'
    })
  })

  it('matches an observation when the envelope holds the identifier', () => {
    const response = { coins: { 'ethereum:0xa': chart([{ timestamp: BASE_EOD + 60, price: 1.5 }]) } }
    expect(matchChartResponse(response, 'ethereum:0xa', BASE_EOD, { maximumOffsetSeconds: 3_600 })).toMatchObject({
      kind: 'matched',
      price: 1.5,
      offsetSeconds: 60
    })
  })
})

describe('summarizeRangeResponse', () => {
  it('counts response points, usable points, and missing daily periods', () => {
    const coin = chart([
      { timestamp: BASE_EOD + 60, price: 1 },
      { timestamp: BASE_EOD + 2 * DAY_SECONDS - 30, price: 1.1 },
      { timestamp: BASE_EOD + 5 * DAY_SECONDS, price: 1.2 },
      { timestamp: BASE_EOD + 120, price: Number.NaN }
    ])

    expect(
      summarizeRangeResponse(coin, {
        rangeStart: BASE_EOD,
        rangeEnd: BASE_EOD + 2 * DAY_SECONDS,
        offsetSeconds: 3_600
      })
    ).toEqual({
      responsePoints: 4,
      usablePoints: 2,
      missingDailyPeriods: [BASE_EOD + DAY_SECONDS],
      firstPeriodResolved: true,
      lastPeriodResolved: true
    })
  })

  it('reports both boundaries as unresolved when the range has no usable point', () => {
    expect(
      summarizeRangeResponse(chart([]), {
        rangeStart: BASE_EOD,
        rangeEnd: BASE_EOD + DAY_SECONDS,
        offsetSeconds: 3_600
      })
    ).toMatchObject({ firstPeriodResolved: false, lastPeriodResolved: false, usablePoints: 0 })
  })

  it('ignores observations the eligibility filter rejects', () => {
    const coin = chart([{ timestamp: BASE_EOD + 60, price: 1 }])
    expect(
      summarizeRangeResponse(coin, {
        rangeStart: BASE_EOD,
        rangeEnd: BASE_EOD,
        offsetSeconds: 3_600,
        isEligibleObservation: () => false
      })
    ).toMatchObject({ usablePoints: 0, missingDailyPeriods: [BASE_EOD] })
  })
})

describe('hasEqualDistanceTie', () => {
  it('detects two observations equally distant from the requested EOD', () => {
    const coin = chart([
      { timestamp: BASE_EOD - 300, price: 1 },
      { timestamp: BASE_EOD + 300, price: 1.2 }
    ])
    expect(hasEqualDistanceTie(coin, BASE_EOD, { offsetSeconds: 3_600 })).toBe(true)
  })

  it('reports no tie when one observation is closer', () => {
    const coin = chart([
      { timestamp: BASE_EOD - 100, price: 1 },
      { timestamp: BASE_EOD + 300, price: 1.2 }
    ])
    expect(hasEqualDistanceTie(coin, BASE_EOD, { offsetSeconds: 3_600 })).toBe(false)
  })

  it('excludes ineligible observations from the tie', () => {
    const coin = chart([
      { timestamp: BASE_EOD - 300, price: 1 },
      { timestamp: BASE_EOD + 300, price: 1.2 }
    ])
    expect(
      hasEqualDistanceTie(coin, BASE_EOD, {
        offsetSeconds: 3_600,
        isEligibleObservation: (timestamp) => timestamp > BASE_EOD
      })
    ).toBe(false)
  })
})

describe('aliasEligibilityOf', () => {
  const FANTOM_USDC = getDefiLlamaCoinGeckoAlias('fantom', '0x04068da6c83afcfa0e13ba15a6696662335d5b75')!
  const VALID_UNTIL = FANTOM_USDC.validUntil!

  function fantomTarget(eodTimestamp: number): NormalizedTarget {
    return {
      chainId: 250,
      chain: 'fantom',
      token: FANTOM_USDC.token,
      tokenLowercase: FANTOM_USDC.token.toLowerCase(),
      eodTimestamp
    }
  }

  it('does not alias-attempt a target whose eodTimestamp is past validUntil', () => {
    expect(aliasEligibilityOf(fantomTarget(VALID_UNTIL + 100))).toBeUndefined()
  })

  it('resolves not_found when the only in-window observation is past validUntil', () => {
    const eodTimestamp = VALID_UNTIL - 1_800
    const isEligibleObservation = aliasEligibilityOf(fantomTarget(eodTimestamp))
    expect(isEligibleObservation).toBeDefined()

    const response = { coins: { [FANTOM_USDC.identifier]: chart([{ timestamp: VALID_UNTIL + 60, price: 1.01 }]) } }

    expect(
      matchChartResponse(response, FANTOM_USDC.identifier, eodTimestamp, {
        maximumOffsetSeconds: 3_600,
        isEligibleObservation
      })
    ).toEqual({ kind: 'not_found' })
  })
})

describe('buildReport', () => {
  function capture(window: string, result: 'resolved' | 'not_found', eodTimestamp: number) {
    return {
      cohort: 'gap' as const,
      chainId: 1,
      chain: 'ethereum',
      token: USDC as `0x${string}`,
      eodTimestamp,
      window,
      method: 'direct' as const,
      providerIdentifier: `ethereum:${USDC.toLowerCase()}`,
      rangeStart: eodTimestamp,
      rangeEnd: eodTimestamp,
      result,
      observedTimestamp: result === 'resolved' ? eodTimestamp : null,
      signedOffsetSeconds: result === 'resolved' ? 0 : null,
      absoluteOffsetSeconds: result === 'resolved' ? 0 : null,
      direction: result === 'resolved' ? ('exact' as const) : null,
      price: result === 'resolved' ? 1 : null,
      symbol: 'USDC',
      confidence: 0.99,
      retainedWarmupPrice: null,
      relativeDifference: null,
      equalDistanceTie: false,
      attempts: 1,
      diagnosticCodes: []
    }
  }

  function manifest(eodTimestamps: number[]) {
    return parseManifest(
      Buffer.from(
        JSON.stringify({
          version: 1,
          targets: eodTimestamps.map((eodTimestamp) => ({ chainId: 1, token: USDC, eodTimestamp }))
        })
      )
    )
  }

  it('keeps the full capture and request records plus incremental coverage', () => {
    const captureRecords = [
      capture('1h', 'not_found', BASE_EOD),
      capture('1h', 'resolved', BASE_EOD + DAY_SECONDS),
      capture('6h', 'resolved', BASE_EOD),
      capture('6h', 'resolved', BASE_EOD + DAY_SECONDS)
    ]
    const requestRecords = [
      {
        window: '1h',
        method: 'direct' as const,
        providerIdentifier: `ethereum:${USDC.toLowerCase()}`,
        rangeStart: BASE_EOD,
        rangeEnd: BASE_EOD + DAY_SECONDS,
        requestedPeriods: 2,
        result: 'ok' as const,
        responsePoints: 3,
        usablePoints: 1,
        missingDailyPeriods: [BASE_EOD],
        firstPeriodResolved: false,
        lastPeriodResolved: true,
        attempts: 1
      }
    ]

    const report = buildReport({
      controlManifestPath: 'control.json',
      gapManifestPath: 'gap.json',
      controlManifest: manifest([BASE_EOD]),
      gapManifest: manifest([BASE_EOD, BASE_EOD + DAY_SECONDS]),
      windows: WINDOWS,
      captureRecords,
      requestRecords,
      gapTargetsNowPopulated: [],
      stats: { apiCalls: 1, retries: 0, requestFailures: 0 }
    })

    expect(report.records).toEqual(captureRecords)
    expect(report.recordCount).toBe(4)
    expect(report.requests).toEqual(requestRecords)
    expect(report.requestCount).toBe(1)
    expect(report.incrementalCoverage).toEqual([
      {
        window: '1h',
        resolvedTargets: 1,
        newlyResolvedTargets: 1,
        newlyResolved: [`1:${USDC}:${BASE_EOD + DAY_SECONDS}`]
      },
      {
        window: '6h',
        resolvedTargets: 2,
        newlyResolvedTargets: 1,
        newlyResolved: [`1:${USDC}:${BASE_EOD}`]
      }
    ])
  })

  it('summarizes per-window cohort offset distributions and directions', () => {
    const resolvedAt = (eodTimestamp: number, signedOffsetSeconds: number, direction: 'before' | 'after') => ({
      ...capture('6h', 'resolved' as const, eodTimestamp),
      signedOffsetSeconds,
      absoluteOffsetSeconds: Math.abs(signedOffsetSeconds),
      direction,
      observedTimestamp: eodTimestamp + signedOffsetSeconds
    })
    const captureRecords = [resolvedAt(BASE_EOD, -300, 'before'), resolvedAt(BASE_EOD + DAY_SECONDS, 100, 'after')]

    const report = buildReport({
      controlManifestPath: 'control.json',
      gapManifestPath: 'gap.json',
      controlManifest: manifest([BASE_EOD]),
      gapManifest: manifest([BASE_EOD, BASE_EOD + DAY_SECONDS]),
      windows: [{ label: '6h', searchWidth: '6h', offsetSeconds: 21_600 }],
      captureRecords,
      requestRecords: [],
      gapTargetsNowPopulated: [],
      stats: { apiCalls: 1, retries: 0, requestFailures: 0 }
    })

    const gap = report.byWindow[0].gap
    expect(gap.targets).toBe(2)
    expect(gap.directResolved).toBe(2)
    expect(gap.direction).toEqual({ before: 1, exact: 0, after: 1 })
    expect(gap.signedOffsetSeconds).toMatchObject({ count: 2, min: -300, median: -300, p90: 100, max: 100 })
    expect(gap.absoluteOffsetSeconds).toMatchObject({ count: 2, min: 100, median: 100, p90: 300, max: 300 })
  })
})

describe('toCsv', () => {
  it('keeps negative numbers intact and neutralizes formula strings', () => {
    const csv = toCsv([{ symbol: '=SUM(A1)', signedOffsetSeconds: -135 } as never])
    const header = csv.split('\n')[0].split(',')
    const row = csv.split('\n')[1].split(',')

    expect(row[header.indexOf('signedOffsetSeconds')]).toBe('-135')
    expect(row[header.indexOf('symbol')]).toBe("'=SUM(A1)")
  })
})
