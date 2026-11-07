import { expect, it, vi } from 'vitest'
import { RunCache } from '../../../src/sources/onchain/run-cache'

it('coalesces pending reads and evicts rejected work for recovery', async () => {
  const cache = new RunCache<number>()
  const load = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(42)
  const first = cache.get('block', load)
  expect(cache.get('block', load)).toBe(first)
  await expect(first).rejects.toThrow('503')
  expect(await cache.get('block', load)).toBe(42)
  expect(await cache.get('block', load)).toBe(42)
  expect(load).toHaveBeenCalledTimes(2)
})

it('bounds retained entries and refreshes recency on a hit', async () => {
  const cache = new RunCache<number>(2)
  await cache.get('a', async () => 1)
  await cache.get('b', async () => 2)
  await cache.get('a', async () => 99)
  await cache.get('c', async () => 3)
  expect(cache.has('a')).toBe(true)
  expect(cache.has('b')).toBe(false)
  expect(cache.stats.evictions).toBe(1)
})
