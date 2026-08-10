import type { OnchainAdapterOptions } from '../context'
import type { RecursivePriceAdapter } from '../types'
import { aaveAdapter } from './aave'
import { beetsBarAdapter } from './beets-bar'
import { compoundAdapter } from './compound'
import { erc4626Adapter } from './erc4626'
import { nativeShareAdapter } from './native-share'
import { reserveRTokenAdapter } from './reserve-rtoken'
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
    reserveRTokenAdapter(options),
    beetsBarAdapter(options),
    erc4626Adapter(options),
    yearnShareAdapter(options),
    compoundAdapter(options),
    aaveAdapter(options),
    wstEthAdapter(options),
  ]
}
