import { ApiError } from '../http/errors'
import { createEnsoSpotSource } from '../sources'
import type { SpotPrice, SpotPriceSource } from '../sources/types'
import type { Env } from '../types'

export function createSpotSources(env: Env): SpotPriceSource[] {
  if (!env.ENSO_API_KEY) {
    throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  }
  return [createEnsoSpotSource(env.ENSO_API_KEY)]
}

export class SpotSourceRegistry {
  private readonly sources: SpotPriceSource[]

  constructor(sources: SpotPriceSource[]) {
    const names = new Set<string>()
    for (const source of sources) {
      if (names.has(source.name)) {
        throw new Error(`Duplicate spot price source name: ${source.name}`)
      }
      names.add(source.name)
    }
    // Stable sort: equal priorities keep registration order.
    this.sources = [...sources].sort((a, b) => a.priority - b.priority)
  }

  all(): readonly SpotPriceSource[] {
    return this.sources
  }

  /**
   * Tries sources in priority order; first price wins. NOT_FOUND and null
   * fall through to the next source. Any other error is remembered and
   * rethrown only if no later source produces a price, so a transient
   * failure in one source never masks a working fallback.
   */
  async resolve(chainId: number, token: string): Promise<SpotPrice> {
    let lastError: unknown

    for (const source of this.sources) {
      if (!source.supports(chainId)) {
        continue
      }

      try {
        const price = await source.getSpotPrice(chainId, token)
        if (price !== null) {
          return { ...price, source: source.name }
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          continue
        }
        lastError = error
      }
    }

    if (lastError !== undefined) {
      throw lastError
    }

    throw new ApiError('NOT_FOUND', 'No price available for this token')
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
