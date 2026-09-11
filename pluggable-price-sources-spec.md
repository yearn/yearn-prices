# Spec: pluggable price sources + core refactor (v3)

Status: v3 — supersedes v2. All PR #24 content removed. This spec covers exactly two things: a plug-and-play price-source system and the refactor of the existing service onto it. No EOD pipeline, no candidates/evidence, no on-chain adapters, no queue/worker.

## Goal

Add a new price source = one source file + one line in the registry source list + one test file. No edits to registry classes, routes, or other sources.

## Scope

- Covers BOTH capabilities of the existing service: spot (live) and historical (timestamped) prices.
- Spot: currently hardwired to Enso in `handleSpot`. Refactor: route through the registry; Enso becomes the first source.
- Historical: currently DB-only reads. Refactor: single-token historical lookup falls back to the registry on DB miss; the existing (currently unused) `DefiLlamaClient.getHistorical` becomes the first historical source. DB stays the primary read path; `SOURCE_PRIORITY` for stored rows is untouched.
- Batch/range historical endpoints stay DB-only in v1 (a registry fallback inside a 50-token batch means up to 50 upstream calls per request — separate decision).

## Plugin contract

```ts
export interface SpotPriceResult {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
}

export interface SpotPriceSource {
  name: string          // stable id; the registry stamps it on results
  priority: number      // lower = tried first; ties keep registration order
  supports(chainId: number): boolean
  getSpotPrice(chainId: number, token: string): Promise<SpotPriceResult | null>
}

export interface HistoricalPriceResult {
  price: number
  timestamp: number
  symbol: string | null
  confidence: number | null
}

export interface HistoricalPriceSource {
  name: string          // stable id; the registry stamps it on results
  priority: number      // lower = tried first; ties keep registration order
  supports(chainId: number): boolean
  getHistoricalPrice(
    chainId: number,
    token: string,
    timestamp: number,
  ): Promise<HistoricalPriceResult | null>
}
```

Semantics:
- Return `null` = "no price for this token here" → resolver falls through to the next source.
- Throw `ApiError('NOT_FOUND', …)` = same as `null`.
- Any other error = transient; remembered and rethrown only if no later source produces a price, so one flaky source never masks a working fallback.
- The registry, not the source, stamps `source` on returned prices.
- A source owns its own config (API key from `Env`, base URL, rate limiter); nothing source-specific leaks into the registry classes or routes.

## Registries & Singletons

- Shared resolve algorithm lives in generic `SourceRegistry` (`src/registries/source-registry.ts`).
- `SpotSourceRegistry` and `HistoricalSourceRegistry` are thin typed wrappers (distinct exported classes/singletons) in `spot.ts` / `historical.ts`.
- Registries are instantiated lazily as Worker isolate singletons via `getSpotSourceRegistry(env)` and `getHistoricalSourceRegistry(env)` to prevent per-request allocations.
- Priority-sorted at construction; duplicate names throw at boot.
- `resolve` iterates supported sources in priority order; first price wins.
- Existing error envelope behavior preserved: `NOT_FOUND` → permanent "no price" envelope; anything else → `UNAVAILABLE` (retryable).

## Layout

```
src/
  sources/
    types.ts        # SpotPriceSource, HistoricalPriceSource contracts
    enso.ts         # spot source #1 (wraps existing EnsoClient)
    defillama.ts    # historical source #1 (wraps existing DefiLlamaClient)
    index.ts        # exports concrete sources & types
  registries/
    source-registry.ts  # generic SourceRegistry (constructor + resolve algorithm)
    spot.ts             # SpotSourceRegistry wrapper, createSpotSources(env) & singleton
    historical.ts       # HistoricalSourceRegistry wrapper, createHistoricalSources(env) & singleton
    index.ts            # barrel export for registries & resetSourceRegistries()
  clients/          # external HTTP clients & RPC helpers (enso, defillama, http-client, rpc, curve)
  db/               # Neon pool & SQL queries
  cache/            # edge cache matching (edge.ts) & Cache-Control policies (headers.ts)
  http/             # auth, typed errors, response helpers
  utils/            # chains, time, validation, number formatting
```

Routes talk to `getSpotSourceRegistry(env)` / `getHistoricalSourceRegistry(env)` only. The pre-existing clients, http-client, cache, chains and validation modules move into the subdirectories above; their behavior is unchanged.

## Adding a source (the definition)

1. Create `src/sources/<name>/`: a class extending `SpotPriceSourceBase` or `HistoricalPriceSourceBase`, a `create<Name>Source()` factory, and an `index.ts` exporting both. Re-export it from `src/sources/index.ts`.
2. Add one line in `src/registries/spot.ts` (`createSpotSources`) or `src/registries/historical.ts` (`createHistoricalSources`) with an explicit `priority`.
3. Add `test/sources/<name>/<file>.test.ts` covering: valid price mapping, the `null`/NOT_FOUND path, transient-error behavior, `supports()` boundaries.
4. Nothing else. A PR touching registry resolution logic, routes, or another source to add a source is wrong by definition.

## Testing

- `test/registries/registries.test.ts`: priority order, null fall-through, NOT_FOUND fall-through, transient rethrow when nothing succeeds, fallback masking a transient error, duplicate-name throw, lazy singleton caching & reset.
- Per-source tests per the checklist above, using the repo's existing vitest + fetch-mocking style.
- Existing route tests (`test/prices-spot.test.ts`, historical tests) keep passing — the refactor must not change response shapes, cache headers, or error envelopes.

## Out of scope

Everything from PR #24: EOD/daily pricing, candidates/evidence/disagreement, tier taxonomies of on-chain adapters, recursion/`ctx.require`, allowlist configs, queue/worker/cron, migrations, new chains.
