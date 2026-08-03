import { describe, expect, test, vi } from 'vitest'
import { discoverYearnDailyTargets } from '../src/daily-target-discovery'

const EOD = 1_704_153_599

describe('daily target discovery', () => {
  test('deduplicates supported vault shares and underlying assets with roles', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        chainId: 1,
        address: '0x0000000000000000000000000000000000000001',
        symbol: 'yvTEST',
        apiVersion: '3.0.0',
        decimals: 18,
        asset: { address: '0x0000000000000000000000000000000000000002' },
      },
      {
        chainId: 1,
        address: '0x0000000000000000000000000000000000000002',
        symbol: 'nested',
        apiVersion: '3.0.0',
        decimals: 18,
        asset: { address: '0x0000000000000000000000000000000000000003' },
      },
      { chainId: 999999, address: '0x0000000000000000000000000000000000000004' },
    ]), { status: 200 }))

    const targets = await discoverYearnDailyTargets(EOD, { request })

    expect(targets).toHaveLength(3)
    expect(targets.find(target => target.token.endsWith('0002'))?.metadata).toMatchObject({
      origin: 'kong-vault-inventory',
      roles: ['underlying', 'vault-share'],
    })
    expect(targets.every(target => target.eodTimestamp === EOD)).toBe(true)
  })

  test('fails closed when discovery yields no supported assets', async () => {
    const request = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    await expect(discoverYearnDailyTargets(EOD, { request })).rejects.toThrow('did not yield any')
  })
})
