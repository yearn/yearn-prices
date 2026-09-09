import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs the CLI without constructing a DeFiLlama route or issuing HTTP requests', () => {
  const folder = mkdtempSync(join(tmpdir(), 'no-defillama-test-'))
  try {
    const manifest = join(folder, 'manifest.json')
    const output = join(folder, 'results.jsonl')
    const marker = join(folder, 'unexpected-http')
    const preload = join(folder, 'forbid-network.ts')
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        targets: [
          { chainId: 1, token: '0x0000000000000000000000000000000000000001', eodTimestamp: 1704067199 }
        ]
      })
    )
    writeFileSync(
      preload,
      `import { writeFileSync } from 'node:fs'; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('Unexpected HTTP'); };`
    )
    const result = spawnSync(
      'bun',
      [
        'run',
        '--preload',
        preload,
        resolve('scripts/replay-historical-adapters.ts'),
        '--manifest',
        manifest,
        '--out',
        output,
        '--no-defillama'
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, RPC_URL_1: '' },
        encoding: 'utf8',
        timeout: 20_000
      }
    )
    expect(result.status, result.stderr).toBe(0)
    const records = readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({
      defillamaEnabled: false,
      defillamaEndpoint: null,
      marketSources: ['chainlink'],
      prefetchUniqueTargets: 0
    })
    expect(records.find((record) => record.type === 'target').status).toBe('missing-rpc')
    expect(records.at(-1)).toMatchObject({ type: 'complete', providerRetries: 0, batching: null })
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
