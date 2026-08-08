# price-service

Cloudflare Worker that serves spot and historical token prices for Yearn. It aggregates prices from DefiLlama, on-chain oracles, Curve, Bob's API, and Enso, and persists historical prices to a Neon Postgres database.

## Requirements

- [Bun](https://bun.sh)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (installed via `bun install`)
- A Neon (or other Postgres) database
- Cloudflare account access, for deploys

## Setup

```bash
bun install
cp .env.example .dev.vars   # wrangler dev reads secrets from .dev.vars
cp .env.example .env        # scripts (warmup, backfill, migrate) read from .env via dotenv
```

Fill in `.dev.vars` and `.env` with real values: a `DATABASE_URL`, one `API_KEY_*` per consumer, `ENSO_API_KEY`, and an `RPC_URL_<chainId>` per supported chain. Both files are gitignored — never commit them.

```bash
bun run dev
```

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the worker locally with `wrangler dev` |
| `bun run deploy` | Deploy the worker with `wrangler deploy` |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run test` | Run the Vitest suite |
| `bun run migrate` | Run pending Postgres migrations (`db-migrate up`) |
| `bun run migrate:create` | Scaffold a new SQL migration file |
| `bun run migrate:down` | Roll back the last migration |
| `bun run warmup` | Pre-populate today's prices for known vaults/tokens |
| `bun run backfill:token-address-checksums` | One-off backfill of checksummed token addresses |

## API

Full route reference, request/response shapes, error codes, and caching behavior are documented in [`docs/routes.md`](docs/routes.md).

## Price sources

Prices are fetched through a pluggable source layer that tries providers in priority order until one returns a result. Currently:

- **Spot prices**: Enso (live prices for any token on supported chains)
- **Historical prices**: DefiLlama (single-token lookups on DB miss; fallback to upstream only when DB has no record)

Batch and range historical endpoints remain DB-only (a registry fallback inside a large batch would generate many upstream requests).

### Adding a new price source

To add a new price source plugin (e.g. CoinGecko, Pyth, custom adapter):

1. **Create the source adapter** in `src/sources/<name>.ts`:
   Implement `SpotPriceSource` and/or `HistoricalPriceSource` interface from `src/sources/types.ts`:
   ```ts
   import type { SpotPriceSource } from './types'

   export function createMySpotSource(): SpotPriceSource {
     return {
       name: 'my-source',
       priority: 20, // lower number = higher priority (tried first)
       supports: (chainId: number) => chainId === 1,
       async getSpotPrice(chainId: number, token: string) {
         // return { price, timestamp, symbol, confidence } or null if not found
       },
     }
   }
   ```

2. **Export the source** in [`src/sources/index.ts`](src/sources/index.ts):
   ```ts
   export { createMySpotSource } from './my-source'
   ```

3. **Register the source in the registry**:
   - For spot sources, add it to `createSpotSources` in [`src/registries/spot.ts`](src/registries/spot.ts):
     ```ts
     export function createSpotSources(env: Env): SpotPriceSource[] {
       if (!env.ENSO_API_KEY) {
         throw new ApiError('INTERNAL_ERROR', 'ENSO_API_KEY is not configured')
       }

       return [
         createEnsoSpotSource(env.ENSO_API_KEY),
         createMySpotSource(),
       ]
     }
     ```
   - For historical sources, add it to `createHistoricalSources` in [`src/registries/historical.ts`](src/registries/historical.ts).

4. **Add unit tests** in `test/sources/<name>.test.ts` covering valid mapping, missing price (`null`), and error handling.

For full architectural details, see [`src/sources/README.md`](src/sources/README.md).

## Authentication

All `/api/prices/*` routes require an API key, sent as either:

- `Authorization: Bearer <api-key>`
- `x-api-key: <api-key>`

The worker has no token database — it checks the presented key against every worker environment variable/secret named `API_KEY_*` (see [`src/http/auth.ts`](src/http/auth.ts)). The matched variable's suffix, lowercased, becomes the `client_id` used in request logs (e.g. `API_KEY_FRONTEND` → `frontend`).

Production secrets, including every `API_KEY_*`, live in the 1Password vault `webops-prod`, item `yearn-price`. `.github/workflows/deploy.yml` pulls them via `1Password/load-secrets-action` and uploads them to the Cloudflare Worker with `wrangler secret bulk` on every push to `main`.

### Generating a new API token

1. **Generate a random secret.**
   ```bash
   openssl rand -base64 32
   ```
2. **Pick a client id** for the consumer, e.g. `KONG`, `FRONTEND`. The env var name will be `API_KEY_<CLIENT_ID>` (uppercase).
3. **Add it to 1Password.** In the `webops-prod` vault, `yearn-price` item, add a new password field named `API_KEY_<CLIENT_ID>` with the generated value.
4. **Wire it into CI.** `.github/workflows/deploy.yml` lists each secret explicitly in two places — add the new key to both:
   - the `env:` block of the "Load secrets from 1Password" step (`API_KEY_<CLIENT_ID>: op://webops-prod/yearn-price/API_KEY_<CLIENT_ID>`)
   - the `jq` object in the "Upload secrets to Cloudflare" step
5. **Deploy.** Merge to `main` (or run the `Deploy Worker` workflow manually) — CI loads the secret from 1Password and uploads it to the Worker via `wrangler secret bulk`.
6. **Local dev:** add the same `API_KEY_<CLIENT_ID>=<value>` line to `.dev.vars` so `wrangler dev` can validate it.
7. **Hand off the token** to the consuming team out-of-band (e.g. a 1Password share link) — never paste it into Slack, git, or a PR.

To rotate or add a key outside of a deploy (e.g. an emergency rotation), you can push directly to the live Worker without going through CI:

```bash
wrangler secret put API_KEY_<CLIENT_ID>
```

This only updates the deployed Worker; remember to also update 1Password and `deploy.yml` so the next CI deploy doesn't overwrite or drop it.

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`: install deps, load secrets from 1Password, upload them to the Worker, run migrations, warm the price cache, then `wrangler deploy`. `.github/workflows/warmup.yml` runs the warmup script hourly on a cron. `.github/workflows/pr.yml` runs typecheck and tests on every PR.

## Testing

```bash
bun run typecheck
bun run test
```
