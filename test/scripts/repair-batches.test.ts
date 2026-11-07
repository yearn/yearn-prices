import { expect, it } from 'vitest'
import { repairGraphBatches } from '../../scripts/lib/repair-batches'

it('groups exact chain/day roots into bounded windows without losing or mutating targets', () => {
  const targets = Array.from({ length: 120 }, (_, i) => ({
    chainId: i % 3 === 0 ? 10 : 1,
    token: `0x${i.toString(16).padStart(40, '0')}`,
    timestamp: i % 2 === 0 ? 20 : 10
  }))
  const before = [...targets]
  const batches = repairGraphBatches(targets, 25)
  expect(targets).toEqual(before)
  expect(batches.flat()).toHaveLength(120)
  expect(new Set(batches.flat().map((target) => target.token)).size).toBe(120)
  expect(batches[0][0].timestamp).toBe(20)
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(25)
    expect(
      batch.every((target) => target.chainId === batch[0].chainId && target.timestamp === batch[0].timestamp)
    ).toBe(true)
  }
})
