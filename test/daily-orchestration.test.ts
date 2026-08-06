import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('production daily EOD orchestration', () => {
  test('schedules the complete cycle with migrations and serialized execution', async () => {
    const [workflow, packageJson, cycle, coverageReport, canaries] = await Promise.all([
      readFile('.github/workflows/daily-eod.yml', 'utf8'),
      readFile('package.json', 'utf8').then(value => JSON.parse(value) as { scripts: Record<string, string> }),
      readFile('scripts/run-daily-price-cycle.ts', 'utf8'),
      readFile('scripts/daily-coverage-report.ts', 'utf8'),
      readFile('scripts/run-adapter-canaries.ts', 'utf8'),
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
    expect(cycle).toContain('pendleTwapSeconds: optionalNumber(process.env.PRICE_PENDLE_TWAP_SECONDS)')
    expect(workflow).toContain('TVL_PRICE_TARGET_INVENTORY_URL: ${{ vars.TVL_PRICE_TARGET_INVENTORY_URL }}')
    expect(workflow).toContain('1Password/install-cli-action@143a85f84a90555d121cde2ff5872e393a47ab9f # v1')
    expect(workflow).toContain('1Password/load-secrets-action@581a835fb51b8e7ec56b71cf2ffddd7e68bb25e0 # v2')
    expect(workflow).not.toMatch(/1Password\/(?:install-cli|load-secrets)-action@v\d/)
    expect(coverageReport).toContain("jsonb_array_elements_text")
    expect(coverageReport).toContain('byRole: roleResult.rows.map')
    expect(canaries).toContain('HyperEVM exact historical block')
    expect(canaries).toContain('HyperEVM USDC direct market')
    expect(canaries).toContain('HyperEVM USDt0 direct market')
    expect(canaries).toContain('archiveBracketValid')
    expect(packageJson.scripts['daily:export']).toBe('bun run scripts/export-daily-price-evidence.ts')
    for (const chainId of [1, 10, 100, 137, 146, 250, 999, 8453, 42161, 80094, 747474]) {
      expect(workflow).toContain(`RPC_URL_${chainId}:`)
    }
  })
})
