import { describe, expect, it } from 'vitest'
import { insertTokenPrices, type Queryable } from '../src/db/queries'
import type { TokenPriceWrite } from '../src/types'
import { currentUtcDayEnd, normalizeToEndOfDay } from '../src/utils'

function recorder(): { calls: Array<{ text: string; values: unknown[] }>; client: Queryable } {
  const calls: Array<{ text: string; values: unknown[] }> = []
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] })
      return { rows: [], rowCount: 0 }
    }
  } as unknown as Queryable
  return { calls, client }
}

const HISTORICAL = normalizeToEndOfDay(1_755_388_799)

function row(timestamp: number, overrides: Partial<TokenPriceWrite> = {}): TokenPriceWrite {
  return {
    chain: 'ethereum',
    token: '0xabc',
    timestamp,
    price: 1,
    symbol: 'YFI',
    confidence: null,
    source: 'defillama',
    ...overrides
  }
}

describe('insertTokenPrices', () => {
  it('leaves historical rows untouched by default', async () => {
    const { calls, client } = recorder()
    await insertTokenPrices(client, [row(HISTORICAL)])

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('DO NOTHING')
    expect(calls[0].text).not.toContain('DO UPDATE')
  })

  it('overwrites historical rows when forceUpdate is set', async () => {
    const { calls, client } = recorder()
    await insertTokenPrices(client, [row(HISTORICAL)], true)

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('DO UPDATE')
  })

  it('keys the conflict target on source so other sources are never touched', async () => {
    const { calls, client } = recorder()
    await insertTokenPrices(client, [row(HISTORICAL)], true)

    expect(calls[0].text).toContain('ON CONFLICT (chain, token, timestamp, source)')
    expect(calls[0].values).toContain('defillama')
  })

  it('still updates today rows without forceUpdate', async () => {
    const { calls, client } = recorder()
    await insertTokenPrices(client, [row(currentUtcDayEnd())])

    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('DO UPDATE')
  })
})
