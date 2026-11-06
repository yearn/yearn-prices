import { afterEach, expect, it, vi } from 'vitest'
import { createOfflineDefiLlamaClient, offlineProvider } from '../../scripts/lib/offline-provider'
import { CHART_RETRY_AFTER_CAP_MS } from '../../src/backfill/constants'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['direct', 'batched'])('blocks a subsequent %s request until the shared 429 cooldown expires', async (kind) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const retry = vi.fn()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
    .mockImplementation(async () => Response.json({ coins: {} }))
  vi.stubGlobal('fetch', fetchMock)
  const client =
    kind === 'direct' ? createOfflineDefiLlamaClient(10, { onRetry: retry }) : offlineProvider(10, { onRetry: retry })
  const first = client.getHistorical(1704067199, ['ethereum:0x1'])
  await vi.advanceTimersByTimeAsync(10)
  expect(retry).toHaveBeenCalledOnce()
  const second = client.getHistorical(1704067199, ['ethereum:0x2'])
  await vi.advanceTimersByTimeAsync(119989)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1011)
  await Promise.all([first, second])
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('caps a multi-hour Retry-After at the shared chart cap', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '7200' } }))
    .mockImplementation(async () => Response.json({ coins: {} }))
  vi.stubGlobal('fetch', fetchMock)
  const first = createOfflineDefiLlamaClient(10).getHistorical(1704067199, ['ethereum:0x1'])
  await vi.advanceTimersByTimeAsync(CHART_RETRY_AFTER_CAP_MS - 1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1_100)
  await first
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('extends the shared cooldown when a later in-flight response reports another 429', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let release: (response: Response) => void = () => {
    throw new Error('Request not started')
  }
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        })
    )
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
    .mockImplementation(async () => Response.json({ coins: {} }))
  vi.stubGlobal('fetch', fetchMock)
  const client = createOfflineDefiLlamaClient(10)
  const first = client.getFirst(['ethereum:0x1'])
  const second = client.getFirst(['ethereum:0x2'])
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(30000)
  release(new Response('{}', { status: 429, headers: { 'Retry-After': '180' } }))
  await vi.advanceTimersByTimeAsync(0)
  const third = client.getFirst(['ethereum:0x3'])
  await vi.advanceTimersByTimeAsync(179999)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([first, second, third])
  expect(fetchMock).toHaveBeenCalledTimes(5)
})

it('honors the final 429 cooldown before sending the next batch', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const retry = vi.fn()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
    .mockImplementation(async () => Response.json({ coins: {} }))
  vi.stubGlobal('fetch', fetchMock)
  const client = offlineProvider(10, { onRetry: retry })
  const targets = Array.from({ length: 6 }, (_, i) => ({
    coin: `ethereum:0x${i + 1}`,
    timestamp: 1704067199
  }))
  const prefetch = client.prefetch(targets)

  await vi.advanceTimersByTimeAsync(10)
  await vi.advanceTimersByTimeAsync(3000)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(retry).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(119_999)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  await prefetch
  expect(fetchMock).toHaveBeenCalledTimes(4)
})

it('opts into today-compatible lookup and exposes batch endpoint and observation time', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
  const now = Math.floor(Date.now() / 1000)
  const todayEnd = Math.floor(now / 86_400) * 86_400 + 86_399
  const coin = 'ethereum:0x1'
  const fetchMock = vi.fn(async () =>
    Response.json({ coins: { [coin]: { symbol: 'T', prices: [{ timestamp: now, price: 4 }] } } })
  )
  vi.stubGlobal('fetch', fetchMock)
  const client = offlineProvider(10, { allowIntraday: true })
  const results = Promise.all([client.getHistorical(now, [coin]), client.getHistorical(todayEnd, [coin])])
  await vi.advanceTimersByTimeAsync(10)
  const [intraday, normalizedDay] = await results

  expect(intraday.coins[coin]).toMatchObject({ timestamp: now, price: 4 })
  expect(normalizedDay.coins[coin]).toMatchObject({ timestamp: now, price: 4 })
  expect(client.endpoint).toBe('/batchHistorical')
  expect(client.getObservationMetadata(coin, todayEnd)).toEqual({
    endpoint: '/batchHistorical',
    requestedTimestamp: todayEnd,
    observedTimestamp: now
  })
  await expect(client.getHistorical(now + 30, [coin])).rejects.toThrow('future timestamps')
  expect(fetchMock).toHaveBeenCalledOnce()
  const requestUrl = new URL(fetchMock.mock.calls[0][0] as string)
  expect(JSON.parse(requestUrl.searchParams.get('coins')!)).toEqual({ [coin]: [now] })
})
