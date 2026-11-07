# price-service

Cloudflare Worker that serves spot prices through Enso, DeFiLlama and on-chain derivation, and historical prices from Neon Postgres.

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

Fill in `.dev.vars` and `.env` with real values: a `DATABASE_URL`, one `API_KEY_*` per consumer, and an `RPC_URL_<chainId>` per supported chain. `ENSO_API_KEY` enables the optional Enso source. Both files are gitignored — never commit them.

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
| `bun run migrate` | Apply pending Drizzle migrations (`drizzle-kit migrate`) |
| `bun run db:generate` | Generate a migration from `src/db/schema.ts` diff |
| `bun run warmup` | Pre-populate today's prices for known vaults/tokens |
| `bun run audit:prices` | Read-only: report Kong vault/underlying `(chain, token, day, source)` gaps in `token_prices` for the last 7 days; exits 1 on any gap or chain without `RPC_URL_<id>` |
| `bun run audit:prices:backfill` | Audit, run warmup if gaps exist, re-audit |
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
Each of the 14 on-chain adapters exposes `discover(target)`: historical reads
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

Use `--no-defillama` for an independent run using Chainlink, the existing
on-chain adapters, and ypriceAPI when its credentials are configured. This disables direct DeFiLlama requests, aliases, and its cache;
it does not add feed mappings, peg assumptions, or spot fallbacks. Returned prices
are candidates, not certified EOD prices. Raw observation times and dependency
paths remain available for review.

## API

Full route reference, request/response shapes, error codes, and caching behavior are documented in [`docs/routes.md`](docs/routes.md).

## Price sources

- **Spot prices**: Enso when configured, then batched DeFiLlama current prices, Chainlink feeds, and recursive on-chain derivation. Underlying tokens use the same market sources. Spot results are not written to historical storage.
- **Historical prices**: stored prices with batched DeFiLlama read-through. Daily reconciliation admits recent Yearn gaps and closed provisional observations to a durable repair queue; validated graph reconstruction finalizes them offline. API reads do not enqueue arbitrary misses. Today is fetched live and remains provisional.

Chain 4663 (Robinhood) has no DefiLlama coverage. Warmup writes WETH/USDG/USDC/USDT from Chainlink (`bun run warmup -- --chain 4663`).

Historical repair now runs through `scripts/repair-historical-prices.ts`: bounded due work every 15 minutes and daily discovery reconciliation. Existing warmup and backfill commands remain available for manual operations. See the [targeted repair runbook](docs/historical-pricing/targeted-repair.md).

Provider cooldowns, proxy rotation, archive RPC failover, optional ypriceAPI
configuration, and the research behind these choices are described in the
[reliability review](docs/historical-pricing/provider-reliability-review.html).

### Adding a new price source

Sources are pluggable adapters under `src/sources/`. Spot sources register in `src/registries/spot.ts` and are served live. Historical graph repair uses its own market-source list and on-chain adapters; adding a historical registry entry alone does not wire it into repair. See [`src/sources/README.md`](src/sources/README.md).

## Authentication

All `/api/prices/*` routes require an API key, sent as either:

- `Authorization: Bearer <api-key>`
- `x-api-key: <api-key>`

The worker has no token database — it checks the presented key against every worker environment variable/secret named `API_KEY_*` (see [`src/http/auth.ts`](src/http/auth.ts)). The matched variable's suffix, lowercased, becomes the `client_id` used in request logs (e.g. `API_KEY_FRONTEND` → `frontend`).

Production secrets, including every `API_KEY_*`, live in the Doppler project `yearn-price`. Each deploy pushes `yearn-price` / `prd` to the Worker with `wrangler secret bulk` before `wrangler deploy`. The sync is additive: a key deleted from Doppler stays on the Worker until removed with `wrangler secret delete`.

The migrate job fetches `yearn-price` / `migrate` and warmup jobs fetch `yearn-price` / `warmup` via Doppler OIDC (`DOPPLER_APP_IDENTITY_ID`) with `inject-env-vars: true`. Deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) come from `webops-shared-prod` / `cloudflare-deploy-configs` via `DOPPLER_PRODUCTION_IDENTITY_ID` inside the reusable `yearn/yearn-gha` workflow.

### Generating a new API token

1. **Generate a random secret.**
   ```bash
   openssl rand -base64 32
   ```
2. **Pick a client id** for the consumer, e.g. `KONG`, `FRONTEND`. The env var name will be `API_KEY_<CLIENT_ID>` (uppercase).
3. **Add it to Doppler** in `yearn-price` / `prd` as `API_KEY_<CLIENT_ID>`.
4. **Publish it** with the next push to `main`, or right away with `wrangler secret put API_KEY_<CLIENT_ID>`.
5. **Local dev:** add the same `API_KEY_<CLIENT_ID>=<value>` line to `.dev.vars` so `wrangler dev` can validate it.
6. **Hand off the token** to the consuming team out-of-band — never paste it into Slack, git, or a PR.

To rotate a key on the live Worker without waiting for a deploy:

```bash
wrangler secret put API_KEY_<CLIENT_ID>
```

Also update Doppler so the next deploy does not revert it. There is no Actions UI redeploy: the reusable Cloudflare workflow only accepts a push to `main`.

## Deployment

### Optional proxy gateway

The pricing Worker can use a separate Bun gateway for rotating HTTP CONNECT
proxies. `gateway/wrangler.toml` deploys it as a Cloudflare Container on the same
account, with one named instance so callers share provider cooldowns and proxy
health. This requires Workers Paid, Containers enabled, and a deploy token with
Workers, Durable Objects and Containers deployment access. Gateway state is in
memory and resets on container replacement; multiple independent deployments do
not share cooldowns. Leave the gateway disabled to keep using direct providers.

1. Create Doppler config `yearn-price/prd_gateway` with a random
   `PRICE_GATEWAY_TOKEN` of at least 32 characters, the intended HTTPS
   `PRICE_GATEWAY_URL` (the gateway Worker's URL), and any of
   `PRICE_PROXY_URLS`, `PRICE_PROXY_LIST_URLS`, `PRICE_PROXY_PUBLIC_LIST=true`.
   Public lists are opt-in; operator-managed proxies can be supplied instead.
2. Create a Doppler OIDC identity restricted to this repository's default-branch
   pushes, with access to that config and
   `webops-shared-prod/cloudflare-deploy-configs`. Set its ID as the Actions
   variable `DOPPLER_GATEWAY_IDENTITY_ID` and set
   `PRICE_GATEWAY_DEPLOY_ENABLED=true` when the account and config are ready.
3. Put the same `PRICE_GATEWAY_URL` and `PRICE_GATEWAY_TOKEN` in
   `yearn-price/prd` to route Worker provider requests through it. Keep proxy
   lists on the gateway. Bun repair jobs can either use those two gateway
   settings in `yearn-price/warmup` or use native proxies directly.

On a push to `main`, CI builds the gateway image before loading credentials,
syncs only its four runtime settings, deploys the gateway Worker and container,
and waits up to five minutes for authenticated `/healthz`. The pricing Worker
deploy waits for gateway success, or skips this dependency when the gateway is
disabled. PR checks build the gateway Worker and Linux image without credentials.
Enso credentials are forwarded per request and are not stored on the gateway.

`bun run gateway:build` bundles the gateway Worker without deploying;
`bun run gateway:deploy` deploys it with the local pinned Wrangler and a running
Docker engine. For an existing host, build `Dockerfile.gateway` and publish port
8788 behind HTTPS, or run `bun run gateway:start` behind a reverse proxy. The
standalone process binds to localhost by default; set `PRICE_GATEWAY_BIND` only
when needed. `/healthz` in the standalone process is local readiness; the
Cloudflare entry point requires authentication even for health requests.

### Pricing Worker and repair jobs

Pushing to `main` runs `.github/workflows/deploy.yml`: migrations first, then the SHA-pinned Cloudflare deploy and a reconciliation/repair job. The repair-queue migration must finish before repair jobs start. `.github/workflows/warmup.yml` now drains due repair targets every 15 minutes and reconciles target discovery daily at 00:30 UTC. Deployment, repair and weekly audit jobs share the historical-maintenance concurrency group.

The weekly audit reconciles first and checks accepted finalized prices for active Yearn vaults and their underlying tokens over the last seven closed days. Any accepted source can satisfy coverage. Missing RPC configuration and unresolved coverage remain audit failures. The heartbeat still uses `$UPTIME_URL` and `$UPTIME_URL/fail`. Manual `warmup` and `audit:prices:backfill` commands remain available, but scheduled jobs no longer launch broad warmup. See the [repair runbook](docs/historical-pricing/targeted-repair.md).

`.github/workflows/pr.yml` runs typecheck and tests on every PR.

## Testing

```bash
bun run typecheck
bun run test
```

See [the graph backfill runbook](docs/historical-pricing/backfill-runbook.md) and [unresolved inventory guide](docs/historical-pricing/README.md).

## Historical price incident repair

The [Curve LP repair runbook](docs/historical-pricing/curve-lp-repair.md) covers the
provider rejection manifest, database quarantine, dated replacements, cache
revision and required consumer refresh for issues #61 and #62. Run migrations
before the updated worker or jobs. Complete closed-day results use a 30-day edge
TTL (`s-maxage=2592000`) and a one-hour browser TTL (`max-age=3600`). Partial
and missing results use five-minute TTLs. A cache revision bump makes repaired
data visible at the edge; it cannot evict responses already stored by browsers
or downstream caches.
