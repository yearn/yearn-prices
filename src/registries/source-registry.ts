import { ApiError } from '../http/errors'

export interface NamedSource {
  name: string
  priority: number
  supports(chainId: number): boolean
}

export type PriceFields = {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
}

export type StampedPrice = PriceFields & { source: string }

/**
 * Priority-ordered source resolver. Tries sources in order; first price wins.
 * NOT_FOUND and null fall through. Other errors are remembered and rethrown
 * only if no later source produces a price.
 */
export class SourceRegistry<TSource extends NamedSource, TArgs extends unknown[] = []> {
  private readonly sources: TSource[]

  constructor(
    sources: TSource[],
    kind: string,
    private readonly fetchPrice: (
      source: TSource,
      chainId: number,
      token: string,
      ...args: TArgs
    ) => Promise<PriceFields | null>,
    private readonly notFoundMessage: string
  ) {
    const names = new Set<string>()
    for (const source of sources) {
      if (names.has(source.name)) {
        throw new Error(`Duplicate ${kind} price source name: ${source.name}`)
      }
      names.add(source.name)
    }
    // Stable sort: equal priorities keep registration order.
    this.sources = [...sources].sort((a, b) => a.priority - b.priority)
  }

  all(): readonly TSource[] {
    return this.sources
  }

  async resolve(chainId: number, token: string, ...args: TArgs): Promise<StampedPrice> {
    let lastError: unknown

    for (const source of this.sources) {
      if (!source.supports(chainId)) {
        continue
      }

      try {
        const price = await this.fetchPrice(source, chainId, token, ...args)
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

    throw new ApiError('NOT_FOUND', this.notFoundMessage)
  }
}
