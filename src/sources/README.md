# Adding a price source

A price source is a plugin that fetches spot or historical token prices. Sources are tried in priority order; the first to return a price wins.

## Interface

Every source implements one or both of these methods:

```ts
interface PriceSource {
  name: string                                  // stable id; must be unique
  priority: number                              // lower = tried first; ties keep registration order
  supports(chainId: number): boolean
  
  getSpotPrice?(chainId: number, token: string): Promise<SpotPrice | null>
  getHistoricalPrice?(chainId: number, token: string, timestamp: number): Promise<HistoricalPrice | null>
}
```

## Return/throw semantics

- **Return `null`** → "no price for this token here" → resolver tries the next source.
- **Throw `ApiError('NOT_FOUND', …)`** → same as `null`.
- **Throw any other error** → "transient failure". Remembered and rethrown **only if no later source produces a price**, so one flaky source never masks a working fallback.
- **Registry stamps `source`** on every returned price. Your source must not.

## Priority and registration order

- Lower `priority` number = tried first.
- Ties keep the order sources are registered (stable sort).
- Duplicate names throw at boot.

## Checklist

### 1. Create the source file

Add `src/sources/<name>.ts`. Implement `SpotPriceSource` and/or `HistoricalPriceSource`.

The source owns its config: API keys from `Env`, base URLs, rate limiters. Nothing leaks into the registry or routes.

**Example: minimal spot source**

```ts
import type { SpotPriceSource } from './types'

export function create<YourName>SpotSource(): SpotPriceSource {
  return {
    name: 'my-source',
    priority: 20,
    supports: (chainId: number) => chainId === 1,  // only Ethereum
    async getSpotPrice(chainId: number, token: string) {
      const response = await fetch(`https://api.example.com/price/${token}`)
      if (!response.ok) {
        return null
      }
      const data = await response.json()
      return {
        price: data.price,
        timestamp: Math.floor(Date.now() / 1000),
        symbol: data.symbol ?? null,
        confidence: null,
      }
    },
  }
}
```

### 2. Register the source

Export your source factory in `src/sources/index.ts`, and register it by adding one line in `src/registries/spot.ts` (`createSpotSources`) or `src/registries/historical.ts` (`createHistoricalSources`). Specify the priority explicitly.

```ts
// src/registries/spot.ts
export function createSpotSources(env: Env): SpotPriceSource[] {
  return [
    createEnsoSpotSource(env.ENSO_API_KEY!),
    create<YourName>SpotSource(),  // <-- add here
  ]
}
```

### 3. Add tests

Create `test/sources/<name>.test.ts` covering:
- ✓ valid response mapping
- ✓ `null` return when price is missing
- ✓ transient-error behavior (thrown error gets rethrown if no fallback succeeds)
- ✓ `supports()` boundaries (one or two supported chains, one unsupported)

Use vitest + fetch-mock (see `test/sources/enso.test.ts` for the pattern).

## Rules

- **Do not touch registry resolution classes**, routes, or other sources. A PR adding a source that edits these files is wrong by definition.
- **Do not call the registry from your source.** Sources are stateless plugins; the registry orchestrates them.
- **Do not include `source` in your return object.** The registry stamps it.
- Return `null` or throw `ApiError('NOT_FOUND', …)` for "I have no price for this token" — not a 404 from a downstream service.

That's it. Three files, no edits elsewhere.
