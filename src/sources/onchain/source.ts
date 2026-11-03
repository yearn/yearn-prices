import { ApiError } from '../../http/errors'
import { HistoricalPriceSourceBase, SpotPriceSourceBase } from '../base'
import type { HistoricalPriceResult, SpotPriceResult } from '../types'
import { DEFAULT_PRIORITY, ONCHAIN_SOURCE_NAME, type OnchainSourceOptions } from './options'
import { OnchainPricer } from './pricer'

function withAbortSignal<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return start()
  }
  if (signal.aborted) {
    return Promise.reject(new ApiError('UNAVAILABLE', 'Spot resolution deadline exceeded'))
  }

  const promise = start()
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(new ApiError('UNAVAILABLE', 'Spot resolution deadline exceeded'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export type { OnchainSourceOptions } from './options'
export { ONCHAIN_SOURCE_NAME } from './options'

export class OnchainSpotSource extends SpotPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getSpotPrice(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPriceResult | null> {
    return withAbortSignal(() => this.pricer.price({ chainId, token, timestamp: null }, signal), signal)
  }
}

export class OnchainHistoricalSource extends HistoricalPriceSourceBase {
  readonly name = ONCHAIN_SOURCE_NAME
  readonly priority: number

  private readonly pricer: OnchainPricer

  constructor(options: OnchainSourceOptions) {
    super()
    this.priority = options.priority ?? DEFAULT_PRIORITY
    this.pricer = new OnchainPricer(options)
  }

  supports(chainId: number): boolean {
    return this.pricer.supports(chainId)
  }

  getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null> {
    return this.pricer.price({ chainId, token, timestamp })
  }
}

export function createOnchainSpotSource(options: OnchainSourceOptions): OnchainSpotSource {
  return new OnchainSpotSource(options)
}

export function createOnchainHistoricalSource(options: OnchainSourceOptions): OnchainHistoricalSource {
  return new OnchainHistoricalSource(options)
}
