import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefiLlamaClient } from '../../src/clients/defillama'
import multiDay from '../fixtures/defillama-chart/01_basic_start_span_period.json'
import oneDay from '../fixtures/defillama-chart/06_neither_end_nor_span.json'
import endOnly from '../fixtures/defillama-chart/07_end_only_no_start.json'
import multiCoin from '../fixtures/defillama-chart/09_multi_coin.json'
import bogusCoin from '../fixtures/defillama-chart/10_bogus_coin.json'
import malformedPeriod from '../fixtures/defillama-chart/11_malformed_period.json'
import casing from '../fixtures/defillama-chart/12_casing_test.json'
import sparse from '../fixtures/defillama-chart/13_weth_searchwidth1.json'

const WETH = 'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const START = 1786732342
const DAY = 86400

function stubFetch(...responses: Array<{ status?: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('unexpected extra fetch call')
    }
    return Response.json(next.body, { status: next.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function calledUrl(fetchMock: ReturnType<typeof stubFetch>, call = 0): URL {
  return new URL(fetchMock.mock.calls[call][0] as unknown as string)
}

async function drain<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  while (!done) {
    await vi.advanceTimersByTimeAsync(1000)
  }
  return work
}

describe('DefiLlamaClient.getChart', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('requests one day and returns a single point', async () => {
    const fetchMock = stubFetch({ body: oneDay })

    const response = await new DefiLlamaClient().getChart([WETH], { start: START, span: 1, period: '1d' })

    expect(response.coins[WETH].prices).toHaveLength(1)
    const url = calledUrl(fetchMock)
    expect(url.pathname).toBe(`/chart/${WETH}`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start: String(START),
      span: '1',
      period: '1d',
      searchWidth: '6h'
    })
  })

  it('requests multiple days and returns raw observation timestamps', async () => {
    stubFetch({ body: multiDay })

    const response = await new DefiLlamaClient().getChart([WETH], { start: START, span: 5, period: '1d' })
    const prices = response.coins[WETH].prices

    expect(prices).toHaveLength(5)
    expect(prices[0].timestamp).toBe(1786732360)
    expect(prices[1].timestamp - prices[0].timestamp).toBe(86410)
  })

  it('returns fewer points than the requested span without failing', async () => {
    stubFetch({ body: multiDay })

    const response = await new DefiLlamaClient().getChart([WETH], { start: START, span: 10, period: '1d' })

    expect(response.coins[WETH].prices).toHaveLength(5)
  })

  it('accepts an observation after the requested grid target', async () => {
    stubFetch({ body: multiDay })

    const response = await new DefiLlamaClient().getChart([WETH], { start: START, span: 5, period: '1d' })

    expect(response.coins[WETH].prices[0].timestamp).toBeGreaterThan(START)
  })

  it('accepts observations before an end-anchored window', async () => {
    const end = 1787077970
    const fetchMock = stubFetch({ body: endOnly })

    const response = await new DefiLlamaClient().getChart([WETH], { end, span: 3, period: '1d' })

    for (const point of response.coins[WETH].prices) {
      expect(point.timestamp).toBeLessThan(end)
    }
    const url = calledUrl(fetchMock)
    expect(url.searchParams.get('end')).toBe(String(end))
    expect(url.searchParams.has('start')).toBe(false)
  })

  it('rejects start and end together without calling the provider', async () => {
    const fetchMock = stubFetch()

    expect(() => new DefiLlamaClient().getChart([WETH], { start: START, end: START + DAY, period: '1d' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(() => new DefiLlamaClient().getChart([WETH], { period: '1d' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an empty coins map when no observation is within the search width', async () => {
    stubFetch({ body: sparse })

    const response = await new DefiLlamaClient().getChart([WETH], {
      start: START,
      span: 5,
      period: '1d',
      searchWidth: '1'
    })

    expect(response.coins).toEqual({})
    expect(response.coins[WETH]).toBeUndefined()
  })

  it('returns 200 with an empty coins map for a bogus coin', async () => {
    stubFetch({ body: bogusCoin })

    await expect(
      new DefiLlamaClient().getChart(['ethereum:0xdeadbeef'], { start: START, span: 2, period: '1d' })
    ).resolves.toEqual({ coins: {} })
  })

  it('echoes the requested coin key verbatim including casing', async () => {
    const requested = 'Ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    stubFetch({ body: casing })

    const response = await new DefiLlamaClient().getChart([requested], { start: START, span: 2, period: '1d' })

    expect(response.coins[requested].prices).toHaveLength(2)
    expect(response.coins[requested.toLowerCase()]).toBeUndefined()
  })

  it('returns one independent entry per requested coin', async () => {
    const coins = [WETH, 'coingecko:ethereum']
    const fetchMock = stubFetch({ body: multiCoin })

    const response = await new DefiLlamaClient().getChart(coins, { start: START, span: 3, period: '1d' })

    expect(Object.keys(response.coins)).toEqual(coins)
    expect(response.coins[WETH].prices[0].price).not.toBe(response.coins['coingecko:ethereum'].prices[0].price)
    expect(calledUrl(fetchMock).pathname).toBe(`/chart/${coins.join(',')}`)
  })

  it('fails on a malformed request the provider rejects with 400', async () => {
    stubFetch({ status: 400, body: malformedPeriod })

    await expect(
      new DefiLlamaClient().getChart([WETH], { start: START, span: 2, period: 'not-a-period' })
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('retries a 429 and returns the following success', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch({ status: 429, body: { message: 'rate limited' } }, { body: multiDay })

    const response = await drain(new DefiLlamaClient().getChart([WETH], { start: START, span: 5, period: '1d' }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(response.coins[WETH].prices).toHaveLength(5)
  })

  it('fails immediately on a 429 when the caller opts out of rate-limit retries', async () => {
    const fetchMock = stubFetch({ status: 429, body: { message: 'rate limited' } }, { body: multiDay })
    const client = new DefiLlamaClient(undefined, undefined, { retryRateLimits: false })

    await expect(client.getChart([WETH], { start: START, span: 5, period: '1d' })).rejects.toMatchObject({
      responseStatus: 429,
      attempts: 1
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
