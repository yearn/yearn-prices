import { afterEach, expect, it, vi } from 'vitest'
import { createOfflineDefiLlamaClient, offlineProvider } from '../../scripts/lib/offline-provider'

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
