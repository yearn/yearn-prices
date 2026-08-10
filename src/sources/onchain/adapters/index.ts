import type { OnchainAdapterOptions } from '../context'
import type { RecursivePriceAdapter } from '../types'
import { beetsBarAdapter } from './beets-bar'
import { erc4626Adapter } from './erc4626'
import { nativeShareAdapter } from './native-share'
import { wstEthAdapter } from './wsteth'
import { yearnShareAdapter } from './yearn-share'

/**
 * Adapters in the order the engine tries them: the most specific token
 * allowlists first, generic interface probes last.
 */
export function createOnchainPriceAdapters(
  options: OnchainAdapterOptions,
): RecursivePriceAdapter[] {
  return [
    nativeShareAdapter(options),
    beetsBarAdapter(options),
    erc4626Adapter(options),
    yearnShareAdapter(options),
    wstEthAdapter(options),
  ]
}
