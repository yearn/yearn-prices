import type { PublicClient } from 'viem'
import { ReadBudgetExceededError } from './errors'

/** Client methods that cost one Worker subrequest each. */
const METERED_METHODS = new Set(['readContract', 'getBlock', 'getBlockNumber'])

export interface ReadBudget {
  readonly spent: number
  meter(client: PublicClient): PublicClient
}

/**
 * Caps how many RPC reads one request may issue. The resolution budget bounds
 * how many tokens are walked; this bounds what each walk costs, so a wide
 * request cannot blow the Worker subrequest limit and fail as a whole.
 */
export function createReadBudget(limit: number): ReadBudget {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('On-chain read budget must be a positive integer')
  }
  let spent = 0
  return {
    get spent() {
      return spent
    },
    meter(client: PublicClient): PublicClient {
      return new Proxy(client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function' || !METERED_METHODS.has(property as string)) {
            return value
          }
          return (...args: unknown[]) => {
            // Counted before dispatch so concurrent reads cannot race past the cap.
            if (spent >= limit) {
              throw new ReadBudgetExceededError(`On-chain pricing exceeded its budget of ${limit} reads`)
            }
            spent += 1
            return (value as (...called: unknown[]) => unknown).apply(target, args)
          }
        }
      })
    }
  }
}
