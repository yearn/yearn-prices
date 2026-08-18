import { describe, expect, it } from 'vitest'
import {
  RetryablePricingError,
  isRetryablePricingError,
} from '../../../src/sources/onchain/errors'

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

describe('isRetryablePricingError', () => {
  it('treats a revert as a permanent answer', () => {
    expect(
      isRetryablePricingError(named('ContractFunctionExecutionError', 'execution reverted')),
    ).toBe(false)
    expect(isRetryablePricingError(named('ContractFunctionZeroDataError', 'returned no data'))).toBe(
      false,
    )
  })

  it('treats transport faults as transient', () => {
    for (const error of [
      new RetryablePricingError('rpc down'),
      named('HttpRequestError', 'HTTP request failed'),
      named('RpcRequestError', 'RPC Request failed'),
      named('UnknownRpcError', 'An unknown RPC error occurred'),
      named('TimeoutError', 'The request timed out'),
      named('SocketError', 'other side closed'),
      new Error('fetch failed'),
      new Error('Status: 429'),
      new Error('HTTP 503 from upstream'),
    ]) {
      expect(isRetryablePricingError(error), error.message).toBe(true)
    }
  })

  it('does not read a client error as transient', () => {
    expect(isRetryablePricingError(new Error('HTTP 400 bad request'))).toBe(false)
    expect(isRetryablePricingError(new Error('nothing to see here'))).toBe(false)
    expect(isRetryablePricingError('not an error')).toBe(false)
    expect(isRetryablePricingError(undefined)).toBe(false)
  })

  it('finds a transient fault wrapped in a cause chain', () => {
    const wrapped = new Error('adapter failed', {
      cause: new Error('read failed', { cause: named('TimeoutError', 'timed out') }),
    })

    expect(isRetryablePricingError(wrapped)).toBe(true)
  })

  it('lets an outer revert win over a transient cause', () => {
    const reverted = new Error('execution reverted', {
      cause: named('TimeoutError', 'timed out'),
    })

    expect(isRetryablePricingError(reverted)).toBe(false)
  })

  it('stops walking a self-referencing cause chain', () => {
    const looped: Error & { cause?: unknown } = new Error('outer')
    looped.cause = looped

    expect(isRetryablePricingError(looped)).toBe(false)
  })
})
