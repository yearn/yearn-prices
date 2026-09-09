import { expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { createReadBudget } from '../../../src/sources/onchain/read-budget'

it('counts raw calls and contract reads against the same budget before dispatch', async () => {
  let dispatched = 0
  const read = async () => {
    dispatched += 1
    return { data: '0x' }
  }
  const budget = createReadBudget(2)
  const client = budget.meter({ call: read, readContract: read } as unknown as PublicClient)
  await client.call({})
  await client.readContract({} as never)
  expect(() => client.call({})).toThrow('budget of 2 reads')
  expect(budget.spent).toBe(2)
  expect(dispatched).toBe(2)
})
