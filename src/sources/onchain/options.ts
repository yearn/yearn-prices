import type { Env } from '../../types'
import type { OnchainAdapterOptions } from './context'
import type { MarketPriceResolver } from './types'

export const ONCHAIN_SOURCE_NAME = 'derived'

export const DEFAULT_PRIORITY = 20
export const DEFAULT_MAX_DEPTH = 8

export interface OnchainSourceOptions extends Partial<OnchainAdapterOptions> {
  /** Prices the tokens an adapter converts into. Injected by the registry. */
  marketPrice: MarketPriceResolver
  /** Worker bindings. Used when `clientForChain` is omitted. */
  env?: Env
  priority?: number
  maxDepth?: number
}
