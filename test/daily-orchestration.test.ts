import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('production daily EOD orchestration', () => {
  test('schedules the complete cycle with migrations and serialized execution', async () => {
    const [workflow, packageJson, cycle, coverageReport] = await Promise.all([
      readFile('.github/workflows/daily-eod.yml', 'utf8'),
      readFile('package.json', 'utf8').then(value => JSON.parse(value) as { scripts: Record<string, string> }),
      readFile('scripts/run-daily-price-cycle.ts', 'utf8'),
      readFile('scripts/daily-coverage-report.ts', 'utf8'),
    ])

    expect(packageJson.scripts['daily:cycle']).toBe('bun run scripts/run-daily-price-cycle.ts')
    expect(workflow).toContain("cron: '30 0 * * *'")
    expect(workflow).toContain('group: daily-eod-prices')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('run: bun run migrate')
    expect(workflow).toContain('run: bun run daily:cycle')
    expect(cycle).toContain('observedTimestamp: selected.observedTimestamp')
    expect(cycle).toContain('source: selected.source')
    expect(cycle).toContain('quality: selected.quality')
    expect(cycle).toContain('candidateId: selected.candidateId')
    expect(cycle).toContain('policyVersion: selected.metadata.policyVersion ?? null')
    expect(cycle).toContain('discoverTvlDailyTargets')
    expect(cycle).toContain('recordUnsupportedDailyPriceTargets')
    expect(workflow).toContain('TVL_PRICE_TARGET_INVENTORY_URL: ${{ vars.TVL_PRICE_TARGET_INVENTORY_URL }}')
    expect(coverageReport).toContain("jsonb_array_elements_text")
    expect(coverageReport).toContain('byRole: roleResult.rows.map')
    for (const chainId of [1, 10, 100, 137, 146, 250, 8453, 42161, 80094, 747474]) {
      expect(workflow).toContain(`RPC_URL_${chainId}:`)
    }
  })
})
