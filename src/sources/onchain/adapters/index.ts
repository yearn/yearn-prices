import type { OnchainAdapterOptions } from '../context'
import type { RecursivePriceAdapter } from '../types'

/**
 * Adapters in the order the engine tries them: the most specific token
 * allowlists first, generic interface probes last.
 */
export function createOnchainPriceAdapters(
  _options: OnchainAdapterOptions,
): RecursivePriceAdapter[] {
  return []
}
