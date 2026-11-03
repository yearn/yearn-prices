import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  acceptedDays: [] as number[],
  query: vi.fn(),
  end: vi.fn(),
  getFirst: vi.fn(),
  getChart: vi.fn()
}))

vi.mock('node:util', () => ({ parseArgs: () => ({ values: mocks.values }) }))
vi.mock('../../src/db', () => ({ createPool: () => ({ query: mocks.query, end: mocks.end }) }))
vi.mock('../../scripts/lib/offline-provider', () => ({
  createOfflineDefiLlamaClient: () => ({ getFirst: mocks.getFirst, getChart: mocks.getChart })
}))

const directory = mkdtempSync(join(tmpdir(), 'historical-coverage-'))
const day = 1782950399 // 2026-07-01 UTC EOD, rejected for this token in the incident manifest.
const token = '0x8c6f28f2f1a3c87f0f938b96d27520d9751ec8d9'

beforeEach(() => {
  vi.resetModules()
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  mocks.acceptedDays = []
  mocks.query.mockImplementation(async () => {
    const days = mocks.acceptedDays
    return {
      rows: [
        {
          first: days.length ? days[0] : null,
          last: days.length ? days.at(-1) : null,
          rows: String(days.length),
          days
        }
      ]
    }
  })
  mocks.end.mockReset()
  mocks.getFirst.mockImplementation(async (coins: string[]) => ({
    coins: Object.fromEntries(coins.map((identifier) => [identifier, { timestamp: day, price: 1 }]))
  }))
  mocks.getChart.mockImplementation(async (coins: string[]) => ({
    coins: Object.fromEntries(
      coins.map((identifier) => [identifier, { symbol: 'MIM', prices: [{ timestamp: day, price: 1 }] }])
    )
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function analyze(acceptedDays: number[]) {
  const inventory = join(directory, `inventory-${acceptedDays.length}.json`)
  const out = join(directory, `out-${acceptedDays.length}`)
  writeFileSync(
    inventory,
    JSON.stringify({
      assets: [
        {
          chainId: 10,
          token,
          observations: [{ date: '2026-07-01', status: 'unresolved' }]
        }
      ]
    })
  )
  mocks.acceptedDays = acceptedDays
  mocks.values = { inventory, out, start: '2026-07-01', end: '2026-07-01' }
  vi.stubEnv('DATABASE_URL', 'postgres://unused')
  vi.spyOn(console, 'log').mockImplementation(() => {})

  await import('../../scripts/analyze-historical-coverage')

  return {
    asset: JSON.parse(readFileSync(join(out, 'coverage.json'), 'utf8')).assets[0],
    out
  }
}

it('keeps quarantined finite-positive provider quotes out of usable coverage and records them', async () => {
  const { asset } = await analyze([])

  expect(asset).toMatchObject({
    providerDays: 0,
    aliasDays: 0,
    quarantinedProviderDays: 1,
    quarantinedDirectProviderRanges: [{ start: '2026-07-01', end: '2026-07-01', days: 1 }],
    usableRanges: [],
    provider: { classifications: ['no-observed-coverage'] }
  })
})

it('uses an accepted database row as independent coverage for a quarantined quote', async () => {
  const { asset, out } = await analyze([day])

  expect(asset).toMatchObject({
    providerDays: 0,
    quarantinedProviderDays: 1,
    storedEod: { availableDays: 1, classifications: ['now-covered'] },
    usableRanges: [{ start: '2026-07-01', end: '2026-07-01', days: 1 }]
  })
  expect(mocks.query.mock.calls[0][0]).toContain('rejected_price_observations')
  expect(mocks.query.mock.calls[0][0]).toContain('FROM token_prices tp')
  expect(out).toBeTruthy()
})
