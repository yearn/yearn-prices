import type { PriceResolutionFailure } from './types'

/** A transient failure: the price may exist, the read did not get through. */
export class RetryablePricingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RetryablePricingError'
  }
}

/** The adapter matched the token but the resulting price is not trustworthy. */
export class InvalidPricingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InvalidPricingError'
  }
}

export class RecursiveDependencyError extends Error {
  constructor(
    message: string,
    readonly failure: PriceResolutionFailure
  ) {
    super(message)
    this.name = 'RecursiveDependencyError'
  }
}

/**
 * Separates transport failures from contract reverts. A revert means "this
 * adapter does not apply"; a transport failure must never be read that way,
 * or a flaky RPC turns into a wrong price.
 */
export function isRetryablePricingError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof RetryablePricingError) return true
    if (!(current instanceof Error)) break
    const message = current.message.toLowerCase()
    if (message.includes('revert') || message.includes('returned no data')) return false
    if (
      current.name === 'HttpRequestError' ||
      current.name === 'RpcRequestError' ||
      current.name === 'UnknownRpcError' ||
      current.name === 'TimeoutError' ||
      current.name === 'SocketError' ||
      message.includes('http request failed') ||
      message.includes('rpc request failed') ||
      message.includes('unknown rpc error occurred') ||
      message.includes('fetch failed') ||
      message.includes('timed out') ||
      /\b(http|status)(\s+code)?:?\s+(408|425|429|5\d\d)\b/.test(message)
    ) {
      return true
    }
    current = 'cause' in current ? current.cause : null
  }
  return false
}

/** The request spent its whole on-chain read allowance. */
export class ReadBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadBudgetExceededError'
  }
}
