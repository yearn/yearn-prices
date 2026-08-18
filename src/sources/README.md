# Adding a price source

A price source is a plugin that fetches spot or historical token prices. Sources are tried in priority order; the first to return a price wins.

## Interface

Every source implements one or both of these methods:

```ts
interface SpotPriceSource {
  name: string                                  // stable id; must be unique
  priority: number                              // lower = tried first; ties keep registration order
  supports(chainId: number): boolean
  getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null>
}

interface HistoricalPriceSource {
  name: string
  priority: number
  supports(chainId: number): boolean
  getHistoricalPrice(chainId: number, token: string, timestamp: number): Promise<HistoricalPriceResult | null>
}
```

## Return/throw semantics

- **Return `null`** → "no price for this token here" → resolver tries the next source.
- **Throw `ApiError('NOT_FOUND', …)`** → same as `null`.
- **Throw any other error** → "transient failure". Remembered and rethrown **only if no later source produces a price**, so one flaky source never masks a working fallback.
- **Registry stamps `source`** on every returned price. Your source must not — `SpotPriceResult` and `HistoricalPriceResult` have no `source` field, so setting one fails typecheck.

## Priority and registration order

- Lower `priority` number = tried first.
- Ties keep the order sources are registered (stable sort).
- Duplicate names throw at boot.

## Checklist

### 1. Create the source file

Add `src/sources/<name>/`. Every source is a folder: the implementation in its own file, and an `index.ts` that exports everything the source makes public. A source with several files (a client wrapper, a lookup table, more than one variant) keeps them together in that folder.

A source is a class extending `SpotPriceSourceBase` or `HistoricalPriceSourceBase`, exported next to a `create<Name>Source()` factory. The base declares the contract, so a missing or mistyped member fails at the class rather than at the registry, and it carries `isUsablePrice`, the finite-positive-price-at-a-real-time rule every source has to apply to a provider payload.

The source owns its config: API keys from `Env`, base URLs, rate limiters. Nothing leaks into the registry or routes.

**Example: minimal spot source**

```ts
import { SpotPriceSourceBase } from '../base'
import type { SpotPriceResult } from '../types'

export class MySpotSource extends SpotPriceSourceBase {
  readonly name = 'my-source'
  readonly priority = 20

  supports(chainId: number): boolean {
    return chainId === 1  // only Ethereum
  }

  async getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null> {
    const response = await fetch(`https://api.example.com/price/${token}`)
    if (!response.ok) {
      return null
    }
    const data = await response.json()
    if (!this.isUsablePrice(data.price, data.timestamp)) {
      return null
    }
    return {
      price: data.price,
      timestamp: data.timestamp,
      symbol: data.symbol ?? null,
      confidence: null,
    }
  }
}

export function createMySpotSource(): MySpotSource {
  return new MySpotSource()
}
```

### 2. Register the source

Export your source factory from `src/sources/<name>/index.ts` and from `src/sources/index.ts`, then register it by adding one line in `src/registries/spot.ts` (`createSpotSources`) or `src/registries/historical.ts` (`createHistoricalSources`). Specify the priority explicitly.

```ts
// src/registries/spot.ts
export function createSpotSources(env: Env): SpotPriceSource[] {
  if (!env.ENSO_API_KEY) {
    throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
  }

  return [
    createEnsoSpotSource(env.ENSO_API_KEY),
    create<YourName>SpotSource(),  // <-- add here
  ]
}
```

If callers must be able to filter on your source with `?source=<name>`, or its rows must rank against other sources in the database, also add the name to `SOURCE_PRIORITY` in `src/types.ts`. Without that, `?source=<name>` returns `INVALID_INPUT` even though the registry will serve the source.

### 3. Add tests

Create `test/sources/<name>/<file>.test.ts` covering:
- ✓ valid response mapping
- ✓ `null` return when price is missing
- ✓ transient-error behavior (thrown error gets rethrown if no fallback succeeds)
- ✓ `supports()` boundaries (one or two supported chains, one unsupported)

Use vitest + fetch-mock (see `test/sources/enso/spot.test.ts` for the pattern).

## Rules

- **Do not touch registry resolution** (`SourceRegistry`, the spot/historical wrappers), routes, or other sources. A PR adding a source that edits these files is wrong by definition.
- **Do not call the registry from your source.** Sources are stateless plugins; the registry orchestrates them.
- **Do not include `source` in your return object.** The registry stamps it.
- Return `null` or throw `ApiError('NOT_FOUND', …)` for "I have no price for this token" — not a 404 from a downstream service.

One folder plus one registry line — plus one line in `SOURCE_PRIORITY` if callers need to filter on your source by name.
