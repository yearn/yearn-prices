import { describe, expect, test, vi } from 'vitest'
import {
  discoverTvlDailyTargets,
  MAX_TVL_PRICE_TARGET_INVENTORY_BYTES,
  parseTvlPriceTargetInventory,
} from '../src/daily-target-discovery'

const EOD = 1_704_153_599
const TOKEN = '0x0000000000000000000000000000000000000001'
const SECOND_TOKEN = '0x0000000000000000000000000000000000000002'
const INVENTORY_URL = 'https://inventory.example/tvl-price-targets.json'

function target(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: `1:${TOKEN}`,
    chainId: 1,
    address: TOKEN,
    roles: ['historical-underlying'],
    requirements: ['historical'],
    origins: [{ type: 'vault', id: `1:${TOKEN}`, roles: ['historical-underlying'] }],
    support: { status: 'supported', adapter: 'ethereum' },
    ...overrides,
  }
}

function inventory(targets: unknown[], problems: unknown[] = []): Record<string, unknown> {
  return {
    schemaVersion: '1.1.0',
    sourceState: { databaseUpdatedAt: '2026-08-04T22:12:48.410Z', vaultRows: 1001 },
    targets,
    problems,
  }
}

describe('TVL daily target discovery', () => {
  test('deduplicates normalized targets while retaining curation and recursive-leaf provenance', () => {
    const discovery = parseTvlPriceTargetInventory(inventory([
      target({
        roles: ['historical-underlying', 'curation'],
        origins: [{ type: 'vault', id: '1:curation-vault', roles: ['historical-underlying', 'curation'] }],
      }),
      target({
        roles: ['current-underlying', 'historical-underlying', 'v1-recursive-leaf'],
        requirements: ['current', 'historical'],
        origins: [{ type: 'legacy-curve', id: '1:legacy-pool', roles: ['v1-recursive-leaf'] }],
      }),
    ]), EOD, INVENTORY_URL)

    expect(discovery.summary).toEqual({
      inventoryTargets: 2,
      normalizedTargets: 1,
      supportedTargets: 1,
      unsupportedTargets: 0,
      malformedEntries: 0,
    })
    expect(discovery.targets[0]).toMatchObject({
      chain: 'ethereum',
      token: TOKEN,
      eodTimestamp: EOD,
      metadata: {
        origin: 'tvl-price-target-inventory',
        inventoryKey: `1:${TOKEN}`,
        roles: ['current-underlying', 'historical-underlying', 'v1-recursive-leaf', 'curation'],
        requirements: ['current', 'historical'],
        origins: [
          { type: 'legacy-curve', id: '1:legacy-pool', roles: ['v1-recursive-leaf'] },
          { type: 'vault', id: '1:curation-vault', roles: ['historical-underlying', 'curation'] },
        ],
      },
    })
  })

  test('accepts schema 1.1 recursive constituent provenance', () => {
    const discovery = parseTvlPriceTargetInventory(inventory([
      target({
        roles: ['current-underlying', 'historical-underlying', 'recursive-constituent'],
        requirements: ['current', 'historical'],
        origins: [{
          type: 'vault',
          id: '1:parent-vault',
          roles: ['current-underlying', 'historical-underlying', 'recursive-constituent'],
        }],
      }),
    ]), EOD, INVENTORY_URL)

    expect(discovery.schemaVersion).toBe('1.1.0')
    expect(discovery.targets[0].metadata).toMatchObject({
      inventorySchemaVersion: '1.1.0',
      roles: ['current-underlying', 'historical-underlying', 'recursive-constituent'],
      origins: [{
        type: 'vault',
        id: '1:parent-vault',
        roles: ['current-underlying', 'historical-underlying', 'recursive-constituent'],
      }],
    })
  })

  test('promotes Gnosis and HyperEVM using consumer support while unknown chains stay unsupported', () => {
    const discovery = parseTvlPriceTargetInventory(inventory([
      target({
        key: `100:${TOKEN}`,
        chainId: 100,
        support: { status: 'unsupported', reason: 'unsupported-chain', chainName: 'Gnosis' },
      }),
      target({
        key: `999:${SECOND_TOKEN}`,
        chainId: 999,
        address: SECOND_TOKEN,
        roles: ['historical-underlying', 'curation'],
        origins: [{ type: 'vault', id: '999:curation-vault', roles: ['historical-underlying', 'curation'] }],
        support: { status: 'unsupported', reason: 'unsupported-chain', chainName: null },
      }),
      target({
        key: `1234:${TOKEN}`,
        chainId: 1234,
        roles: ['historical-underlying'],
        origins: [{ type: 'vault', id: '1234:unknown-vault', roles: ['historical-underlying'] }],
        support: { status: 'unsupported', reason: 'unsupported-chain', chainName: null },
      }),
    ]), EOD, INVENTORY_URL)

    expect(discovery.targets).toEqual([
      expect.objectContaining({ chain: 'gnosis', token: TOKEN }),
      expect.objectContaining({ chain: 'hyperevm', token: SECOND_TOKEN }),
    ])
    expect(discovery.targets[0].metadata).toMatchObject({
      chainId: 100,
      consumerSupport: 'supported',
      producerSupport: { status: 'unsupported' },
    })
    expect(discovery.targets[1].metadata).toMatchObject({
      chainId: 999,
      consumerSupport: 'supported',
      producerSupport: { status: 'unsupported' },
    })
    expect(discovery.unsupportedTargets).toEqual([
      expect.objectContaining({
        chain: '1234',
        token: TOKEN,
        failureReason: expect.stringContaining('no configured chain, RPC, or adapter support'),
        metadata: expect.objectContaining({ consumerSupport: 'unsupported' }),
      }),
    ])
  })

  test('reports malformed targets and preserves producer problems without dropping valid targets', () => {
    const producerProblem = { type: 'invalid', source: 'vault', id: 'bad', reason: 'invalid-address' }
    const discovery = parseTvlPriceTargetInventory(inventory([
      target(),
      target({ key: '1:not-an-address', address: 'not-an-address' }),
    ], [producerProblem]), EOD, INVENTORY_URL)

    expect(discovery.targets).toHaveLength(1)
    expect(discovery.malformedEntries).toEqual([
      expect.objectContaining({ index: 1, key: '1:not-an-address', reason: expect.stringContaining('Unsupported token address') }),
    ])
    expect(discovery.producerProblems).toEqual([producerProblem])
  })

  test('rejects unknown schema majors and requires a configured absolute URL', async () => {
    expect(() => parseTvlPriceTargetInventory({ ...inventory([target()]), schemaVersion: '2.0.0' }, EOD, INVENTORY_URL))
      .toThrow('Unsupported TVL price-target inventory schema version')
    await expect(discoverTvlDailyTargets(EOD, '')).rejects.toThrow('TVL_PRICE_TARGET_INVENTORY_URL is required')
    await expect(discoverTvlDailyTargets(EOD, '/relative.json')).rejects.toThrow('absolute URL')
    await expect(discoverTvlDailyTargets(EOD, 'http://inventory.example/targets.json'))
      .rejects.toThrow('must use https or loopback http')
  })

  test('loads the configured export and returns deterministic results', async () => {
    const body = JSON.stringify(inventory([
      target({ key: `1:${SECOND_TOKEN}`, address: SECOND_TOKEN }),
      target(),
    ]))
    const request = vi.fn().mockImplementation(async () => new Response(body, { status: 200 }))

    const first = await discoverTvlDailyTargets(EOD, INVENTORY_URL, { request })
    const second = await discoverTvlDailyTargets(EOD, INVENTORY_URL, { request })

    expect(first).toEqual(second)
    expect(first.targets.map(item => item.token)).toEqual([TOKEN, SECOND_TOKEN])
    expect(request).toHaveBeenCalledWith(new URL(INVENTORY_URL), {
      signal: expect.any(AbortSignal),
    })
  })

  test('allows loopback HTTP for disposable local validation', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(inventory([target()])), { status: 200 }))

    await expect(discoverTvlDailyTargets(EOD, 'http://127.0.0.1:8787/targets.json', { request }))
      .resolves.toMatchObject({ summary: { normalizedTargets: 1 } })
  })

  test('rejects declared and streamed oversized inventories before parsing', async () => {
    const declaredOversize = vi.fn().mockResolvedValue(new Response('{}', {
      headers: { 'content-length': String(MAX_TVL_PRICE_TARGET_INVENTORY_BYTES + 1) },
    }))
    await expect(discoverTvlDailyTargets(EOD, INVENTORY_URL, { request: declaredOversize }))
      .rejects.toThrow('inventory exceeds')

    const streamedOversize = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TVL_PRICE_TARGET_INVENTORY_BYTES + 1))
        controller.close()
      },
    })))
    await expect(discoverTvlDailyTargets(EOD, INVENTORY_URL, { request: streamedOversize }))
      .rejects.toThrow('inventory exceeds')
  })

  test('aborts a stalled inventory request at the configured timeout', async () => {
    const request = vi.fn().mockImplementation((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))

    await expect(discoverTvlDailyTargets(EOD, INVENTORY_URL, { request, timeoutMs: 1 }))
      .rejects.toThrow('request timed out after 1 ms')
  })

  test('never persists configured URL credentials or query parameters', async () => {
    const body = JSON.stringify(inventory([target()]))
    const request = vi.fn().mockImplementation(async () => new Response(body, { status: 200 }))
    const discovery = await discoverTvlDailyTargets(
      EOD,
      'https://inventory-user:inventory-pass@inventory.example/tvl-price-targets.json?signature=secret#fragment',
      { request },
    )

    expect(discovery.targets[0].metadata?.discoverySource)
      .toBe('https://inventory.example/tvl-price-targets.json')
    expect(request).toHaveBeenCalledWith(
      new URL('https://inventory-user:inventory-pass@inventory.example/tvl-price-targets.json?signature=secret#fragment'),
      { signal: expect.any(AbortSignal) },
    )
  })
})
