import { ApiError } from '../../http/errors'
import { nowUnix } from '../../utils/time'
import { SpotPriceSourceBase } from '../base'
import type { SpotPriceResult } from '../types'
import {
  type ChainlinkHistoricalSource,
  type ChainlinkHistoricalSourceOptions,
  createChainlinkHistoricalSource
} from './historical'

/**
 * Chainlink is an independent spot source for assets with a configured feed.
 * It deliberately reuses the historical round reader: the latest round is
 * still checked for a heartbeat bound and the feed's own `updatedAt` remains
 * the observation timestamp.
 */
export class ChainlinkSpotSource extends SpotPriceSourceBase {
  readonly name = 'chainlink'
  readonly priority = 18

  private readonly historical: ChainlinkHistoricalSource

  constructor(options: ChainlinkHistoricalSourceOptions = {}) {
    super()
    this.historical = createChainlinkHistoricalSource(options)
  }

  supports(chainId: number): boolean {
    return this.historical.supports(chainId)
  }

  getSpotPrice(chainId: number, token: string, signal?: AbortSignal): Promise<SpotPriceResult | null> {
    if (signal?.aborted) {
      return Promise.reject(new ApiError('UNAVAILABLE', 'Chainlink spot resolution was aborted'))
    }

    const request = this.historical.getHistoricalPrice(chainId, token, nowUnix())
    return withAbortSignal(request, signal)
  }
}

/**
 * Races the viem read against the caller's deadline. The underlying viem
 * request cannot be canceled once dispatched, so this only prevents its result
 * from continuing the source chain after the caller has aborted.
 */
function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(new ApiError('UNAVAILABLE', 'Chainlink spot resolution was aborted'))
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new ApiError('UNAVAILABLE', 'Chainlink spot resolution was aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function createChainlinkSpotSource(options: ChainlinkHistoricalSourceOptions = {}): ChainlinkSpotSource {
  return new ChainlinkSpotSource(options)
}
