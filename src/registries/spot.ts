import { ApiError } from '../http/errors'
import { createEnsoSpotSource } from '../sources'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env } from '../types'

import { SourceRegistry } from './source-registry'

export function createSpotSources(env: Env): SpotPriceSource[] {
  if (!env.ENSO_API_KEY) {
    throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  }
  return [createEnsoSpotSource(env.ENSO_API_KEY)]
}

export class SpotSourceRegistry extends SourceRegistry<SpotPriceSource> {
  constructor(sources: SpotPriceSource[]) {
    super(
      sources,
      'spot',
      (source, chainId, token) => source.getSpotPrice(chainId, token),
      'No price available for this token'
    )
  }

  override resolve(chainId: number, token: string): Promise<SpotPrice> {
    return super.resolve(chainId, token)
  }
}

let spotRegistryInstance: SpotSourceRegistry | null = null

export function getSpotSourceRegistry(env?: Env): SpotSourceRegistry {
  if (!spotRegistryInstance) {
    if (!env) {
      throw new Error('Env is required to initialize SpotSourceRegistry')
    }
    spotRegistryInstance = new SpotSourceRegistry(createSpotSources(env))
  }
  return spotRegistryInstance
}

export function resetSpotSourceRegistry(): void {
  spotRegistryInstance = null
}
