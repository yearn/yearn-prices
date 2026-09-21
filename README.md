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
| `bun run replay:historical-adapters --manifest <file> --out <new.jsonl>` | Read-only historical adapter coverage experiment |

`backfill:defillama-day-alignment` takes a phase (`prices`, `derived`, `verify`, `cleanup`, default `all`) and
`--out <file>` (report path, default `backfill-report.json`), `--retry[=db|<file>]` (retry only tokens that failed,
from the progress table or a prior report), `--concurrency <n>` (tokens in flight, default 4). `verify` samples a
fixed YFI/WBTC 2025-08-16..21 window. Pause the hourly warmup workflow while `prices`/`derived` run.

The adapter replay accepts the version-1 gap manifest (`chainId`, `token`,
`eodTimestamp` targets) and writes local candidate/failure evidence, never database
rows. By default it prefetches DeFiLlama observations via `/batchHistorical`, using
the existing five-token/twenty-timestamp grouping and 6-hour observation matcher.
A run-wide cache deduplicates root and child lookups, including confirmed misses;
new dependencies are collected across the workload before fetching each group.
Provider failures remain
retryable errors in the run cache and do not trigger individual-request retries.

The default `--scheduler graph` discovers a workload-wide dependency graph.
Each of the 13 on-chain adapters exposes `discover(target)`: historical reads
produce a complete child list, conversion evidence, and a pure evaluation
function. Discovery does not require child prices. The runner batches each
new market frontier, deduplicates nodes by chain/token/timestamp/block context,
and discovers every applicable alternative route. Captured plans are evaluated
bottom-up with no further RPC, sharing derived results across their parents.
The existing recursive request path uses these same plans and pricing formulas.

The graph has a depth limit of 8 and `--max-nodes <n>` (default 32000), with a
400-read budget per discovered node. Cutoffs, cycles, invalid state and retryable
provider/RPC errors remain explicit; they are not evidence of unsupported tokens.
The output `<out>.graph.json` retains nodes, all route edges, parent links,
conversion state, raw market attempts, selected price paths and failure reasons.
JSONL `graph-frontier` records provide progress; `target` records summarize roots.
Only successful provider responses establish absent observations. A graph can
explain a missing leaf but cannot invent its historical price.

`--scheduler recursive` retains the earlier replay for comparison. Its optional
`--discovery-rounds <0..8>` controls repeated adapter probes (default 8).
The graph scheduler does not use provisional probes or repeated discovery rounds.
Neither scheduler writes production database rows.

Use `--prefetch-evidence <previous.jsonl>` to prefetch child targets discovered in
a previous replay, or `--prefetch-manifest <children.json>` for an explicit
version-1 child request set (requests only; no prices imported). Use
`--concurrency <1..8>` (default 2) for root processing, and
`--provider-rps <1..10>` (default 1) for batch pacing. `--not-before <ISO timestamp>`
delays all provider work; 429 responses share the full `Retry-After` cooldown
(minimum 60 seconds, maximum 12 hours). Output files must not already exist.

Use `--no-defillama` for an independent run using only Chainlink and the existing
on-chain adapters. This disables direct DeFiLlama requests, aliases, and its cache;
it does not add feed mappings, peg assumptions, or spot fallbacks. Returned prices
are candidates, not certified EOD prices. Raw observation times and dependency
paths remain available for review.

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

Production secrets, including every `API_KEY_*`, live in the Doppler project `yearn-price`. CI does **not** upload worker runtime secrets. Sync them out of band whenever they change:

```bash
doppler secrets --json | jq -c 'with_entries(.value = .value.computed)' | wrangler secret bulk
```

A deploy without that sync leaves the live Worker on whatever secrets it already has — there is no CI error.

Migrate and warmup jobs fetch `yearn-price` / `warmup` via Doppler OIDC (`DOPPLER_APP_IDENTITY_ID`) with `inject-env-vars: true`. Deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) come from `webops-shared-prod` / `cloudflare-deploy-configs` via `DOPPLER_PRODUCTION_IDENTITY_ID` inside the reusable `yearn/yearn-gha` workflow.

### Generating a new API token

1. **Generate a random secret.**
   ```bash
   openssl rand -base64 32
   ```
2. **Pick a client id** for the consumer, e.g. `KONG`, `FRONTEND`. The env var name will be `API_KEY_<CLIENT_ID>` (uppercase).
3. **Add it to Doppler** in the `yearn-price` project as `API_KEY_<CLIENT_ID>`.
4. **Sync to the Worker** with the `wrangler secret bulk` command above, or a single `wrangler secret put API_KEY_<CLIENT_ID>`. Merging to `main` does not publish the new key.
5. **Local dev:** add the same `API_KEY_<CLIENT_ID>=<value>` line to `.dev.vars` so `wrangler dev` can validate it.
6. **Hand off the token** to the consuming team out-of-band — never paste it into Slack, git, or a PR.

To rotate a key on the live Worker without waiting for a bulk sync:

```bash
wrangler secret put API_KEY_<CLIENT_ID>
```

Also update Doppler so the next bulk sync does not revert it. There is no Actions UI redeploy: the reusable Cloudflare workflow only accepts a push to `main`.

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`: migrate, then the SHA-pinned `yearn/yearn-gha` Cloudflare deploy (needs migrate). Warmup starts after migrate and does not block deploy. The same workflow is `workflow_dispatch` for a manual run. `.github/workflows/warmup.yml` runs the warmup script hourly and on dispatch. `.github/workflows/pr.yml` runs typecheck and tests on every PR.

## Testing

```bash
bun run typecheck
bun run test
```

See [the graph backfill runbook](docs/historical-pricing/backfill-runbook.md) and [unresolved inventory guide](docs/historical-pricing/README.md).
