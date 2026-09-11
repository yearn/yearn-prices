import type { OnchainAdapterOptions } from '../context'
import type { RecursivePriceAdapter } from '../types'
import { aaveAdapter } from './aave'
import { balancerAdapter } from './balancer'
import { beetsBarAdapter } from './beets-bar'
import { compoundAdapter } from './compound'
import { curveAdapter } from './curve'
import { erc4626Adapter } from './erc4626'
import { nativeShareAdapter } from './native-share'
import { pairAdapter } from './pair'
import { DEFAULT_PENDLE_TWAP_SECONDS, pendleAdapter } from './pendle'
import { reserveRTokenAdapter } from './reserve-rtoken'
import { wstEthAdapter } from './wsteth'
import { yearnShareAdapter } from './yearn-share'
import { yip88LiquidLockerAdapter } from './yip88-liquid-locker'

/**
 * Adapters in the order the engine tries them: the most specific token
 * allowlists first, generic interface probes last.
 */
export function createOnchainPriceAdapters(options: OnchainAdapterOptions): RecursivePriceAdapter[] {
  return [
    yip88LiquidLockerAdapter(options),
    nativeShareAdapter(options),
    reserveRTokenAdapter(options),
    beetsBarAdapter(options),
    erc4626Adapter(options),
    yearnShareAdapter(options),
    compoundAdapter(options),
    aaveAdapter(options),
    wstEthAdapter(options),
    pairAdapter(options),
    balancerAdapter(options),
    pendleAdapter(options, options.pendleTwapSeconds ?? DEFAULT_PENDLE_TWAP_SECONDS),
    curveAdapter(options)
  ]
}
