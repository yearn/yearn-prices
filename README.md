# price-service

Cloudflare Worker that serves Enso spot prices and historical prices from Neon Postgres. Historical rows are written by offline warmup and backfill jobs, not by the worker.

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

Local Neon (Postgres 16 + serverless HTTP proxy, no cloud project):

```bash
bun run db:up
```

Point `DATABASE_URL` in `.env` and `.dev.vars` at `postgres://postgres:postgres@db.localtest.me:54329/price_service`, then `bun run dev` / `bun run warmup`. Tear down with `bun run db:down`. Postgres is on host port **54329** (5432 is already taken by other stacks).

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
| `bun run backfill:defillama-day-alignment` | One-off repair of DeFiLlama prices stored against the wrong day |

`backfill:defillama-day-alignment` takes a phase (`prices`, `derived`, `verify`, `cleanup`, default `all`) and
`--out <file>` (report path, default `backfill-report.json`), `--retry[=db|<file>]` (retry only tokens that failed,
from the progress table or a prior report), `--concurrency <n>` (tokens in flight, default 4). `verify` samples a
fixed YFI/WBTC 2025-08-16..21 window. Pause the hourly warmup workflow while `prices`/`derived` run.

## API

Full route reference, request/response shapes, error codes, and caching behavior are documented in [`docs/routes.md`](docs/routes.md).

## Price sources

- **Spot prices**: Enso (live prices for any token on supported chains)
- **Historical prices**: read from `token_prices` only. No historical route calls an upstream provider; a row that is not in the table returns `404` (single token) or is omitted from the response (batch, range), and stays that way until an offline job writes it.

Chain 4663 (Robinhood) has no DefiLlama coverage. Warmup writes WETH/USDG/USDC/USDT from Chainlink (`bun run warmup -- --chain 4663`).

Historical rows are written by `scripts/warmup-prices.ts` (hourly: DefiLlama, Chainlink, Curve, derived), `scripts/backfill-historical-gaps.ts` and `scripts/backfill-defillama-day-alignment.ts`. One-off migrations (`scripts/backfill-token-address-checksums.ts`) copy existing rows and add no new prices. `docs/routes.md` lists which job writes each `source` value.

### Adding a new price source

Sources are pluggable adapters under `src/sources/`. Spot sources register in `src/registries/spot.ts` and are served live. Historical sources register in `src/registries/historical.ts` but have no request-path consumer — extend a warmup or backfill job so rows reach the table. See [`src/sources/README.md`](src/sources/README.md).

## Authentication

All `/api/prices/*` routes require an API key, sent as either:

- `Authorization: Bearer <api-key>`
- `x-api-key: <api-key>`

The worker has no token database — it checks the presented key against every worker environment variable/secret named `API_KEY_*` (see [`src/http/auth.ts`](src/http/auth.ts)). The matched variable's suffix, lowercased, becomes the `client_id` used in request logs (e.g. `API_KEY_FRONTEND` → `frontend`).

Production Worker secrets, including every `API_KEY_*`, live in the Doppler project `yearn-price`. CI does not upload them; sync them to the Worker out of band whenever they change:

```bash
doppler secrets --json -p yearn-price -c prd | jq -c 'with_entries(.value = .value.computed)' | wrangler secret bulk
```

### Generating a new API token

1. **Generate a random secret.**
   ```bash
   openssl rand -base64 32
   ```
2. **Pick a client id** for the consumer, e.g. `KONG`, `FRONTEND`. The env var name will be `API_KEY_<CLIENT_ID>` (uppercase).
3. **Add it to Doppler.** In project `yearn-price`, config `prd`, add `API_KEY_<CLIENT_ID>` with the generated value.
4. **Sync it to the Worker** with the `doppler secrets ... | wrangler secret bulk` command above.
5. **Local dev:** add the same `API_KEY_<CLIENT_ID>=<value>` line to `.dev.vars` so `wrangler dev` can validate it.
6. **Hand off the token** to the consuming team out-of-band (e.g. a 1Password share link) — never paste it into Slack, git, or a PR.

To rotate or add a key outside of a deploy (e.g. an emergency rotation), you can push directly to the live Worker without going through CI:

```bash
wrangler secret put API_KEY_<CLIENT_ID>
```

This only updates the deployed Worker; remember to also update Doppler so the next sync doesn't overwrite or drop it.

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`: a `prepare` job fetches Doppler project `yearn-price` config `prd` via OIDC (`DOPPLER_PREPARE_IDENTITY_ID` repo var), injects those values as env vars, then runs migrations and warms the price cache. The reusable `yearn/yearn-gha` Cloudflare deploy workflow then fetches `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from Doppler project `webops-shared-prod` config `cloudflare-deploy-configs` via OIDC (`DOPPLER_PRODUCTION_IDENTITY_ID` repo var) and runs `wrangler deploy`. Only pushes to `main` deploy; there is no manual dispatch. `.github/workflows/warmup.yml` runs the warmup script hourly on a cron, reading the same Doppler `yearn-price`/`prd` config via the same identity; Doppler is the only secret source for CI. `.github/workflows/pr.yml` runs typecheck and tests on every PR.

## Testing

```bash
bun run typecheck
bun run test
```
