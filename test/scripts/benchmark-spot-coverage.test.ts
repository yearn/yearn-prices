import { describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTargetFile,
  SharedSpotSourceCache,
  type SpotCoverageTarget
} from '../../scripts/benchmark-spot-coverage'
import type { SpotPriceSource } from '../../src/sources/types'

function fixtureSource(getSpotPrice: SpotPriceSource['getSpotPrice']): SpotPriceSource {
  return { name: 'fixture', priority: 1, supports: () => true, getSpotPrice }
}

describe('spot coverage benchmark helpers', () => {
  it('normalizes and deduplicates explicit target files deterministically', () => {
    const path = join(tmpdir(), `spot-targets-${Date.now()}.json`)
    writeFileSync(
      path,
      JSON.stringify({
        targets: [
          { chain: 'Ethereum', token: '0x0000000000000000000000000000000000000001', label: 'first' },
          { chainId: 1, token: '0x0000000000000000000000000000000000000001', label: 'duplicate' },
          { chainId: 10, address: '0x0000000000000000000000000000000000000002' }
        ]
      })
    )

    expect(parseTargetFile(path)).toEqual([
      {
        chainId: 1,
        chain: 'ethereum',
        token: '0x0000000000000000000000000000000000000001',
        label: 'first'
      },
      {
        chainId: 10,
        chain: 'optimism',
        token: '0x0000000000000000000000000000000000000002',
        label: null
      }
    ] satisfies SpotCoverageTarget[])
  })

  it('shares successful and failed source calls across runs', async () => {
    const cache = new SharedSpotSourceCache()
    const getSpotPrice = vi
      .fn<SpotPriceSource['getSpotPrice']>()
      .mockResolvedValue({ price: 2, timestamp: 1, symbol: null, confidence: null })
    const wrapped = cache.wrap(fixtureSource(getSpotPrice))
    const token = '0x0000000000000000000000000000000000000001'

    await wrapped.getSpotPrice(1, token)
    await wrapped.getSpotPrice(1, token)

    expect(getSpotPrice).toHaveBeenCalledTimes(1)
    expect(cache.report()).toMatchObject({ sharedSourceInvocations: { fixture: 1 }, sharedSourceCacheHits: { fixture: 1 } })
  })

  it('keeps source errors in the shared cache', async () => {
    const cache = new SharedSpotSourceCache()
    const getSpotPrice = vi.fn<SpotPriceSource['getSpotPrice']>().mockRejectedValue(new Error('provider down'))
    const wrapped = cache.wrap(fixtureSource(getSpotPrice))
    const token = '0x0000000000000000000000000000000000000001'

    await expect(wrapped.getSpotPrice(1, token)).rejects.toThrow('provider down')
    await expect(wrapped.getSpotPrice(1, token)).rejects.toThrow('provider down')
    expect(getSpotPrice).toHaveBeenCalledTimes(1)
  })
})
