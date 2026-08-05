# price-service

Cloudflare Worker that serves spot and historical token prices for Yearn. It aggregates prices from DefiLlama, on-chain oracles, Curve, Bob's API, and Enso, and persists historical prices to a Neon Postgres database.

Historical pricing is EOD-first: one accepted price per chain, token, and closed UTC day, stored at exactly
`23:59:59 UTC`. Missing days are repaired by an explicit durable worker, never inside GET requests. The product
contract, evidence policy, queue lifecycle, and adapter methodology are documented in
[`docs/eod-pricing.md`](docs/eod-pricing.md).

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

Fill in `.dev.vars` and `.env` with real values: a `DATABASE_URL`, one read-only `API_KEY_*` per consumer,
`ENSO_API_KEY`, an `RPC_URL_<chainId>` per supported chain, and the configured
`TVL_PRICE_TARGET_INVENTORY_URL` export used by `daily:cycle`. Both files are gitignored — never commit them.

For isolated validation and previews, `DATABASE_SCHEMA` may select a safe Postgres schema without duplicating or
printing the database URL.

```bash
bun run dev
```

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the worker locally with `wrangler dev` |
| `bun run deploy` | Deploy the worker with `wrangler deploy` |
| `bun run typecheck` | Type-check with `tsc --noEmit` |
| `bun run lint` | Type-check and enforce repository text/artifact rules |
| `bun run test` | Run the Vitest suite |
| `bun run migrate` | Run pending Postgres migrations (`db-migrate up`) |
| `bun run migrate:create` | Scaffold a new SQL migration file |
| `bun run migrate:down` | Roll back the last migration |
| `bun run warmup` | Pre-populate today's prices for known vaults/tokens |
| `bun run backfill:token-address-checksums` | One-off backfill of checksummed token addresses |
| `bun run daily:enqueue-file <targets.jsonl>` | Idempotently enqueue exact-EOD daily targets |
| `bun run daily:run` | Resolve the durable daily queue with bounded concurrency |
| `bun run daily:cycle` | Discover the latest closed day's Yearn assets and run the complete durable cycle |
| `bun run daily:status` | Print durable EOD queue progress |
| `bun run daily:canaries` | Run representative historical live canaries for every on-chain adapter |
| `bun run daily:report` | Print the complete EOD coverage and evidence breakdown |

## API

Full route reference, request/response shapes, error codes, and caching behavior are documented in [`docs/routes.md`](docs/routes.md).

Queue data is available to authenticated readers at
`/api/daily-prices/progress`. Enqueue and audited requeue operations require the dedicated operator key; consumer
application keys cannot mutate queue state.

## Authentication

All `/api/prices/*` routes require an API key, sent as either:

- `Authorization: Bearer <api-key>`
- `x-api-key: <api-key>`

The worker has no token database — it checks read requests against environment variables/secrets named `API_KEY_*` (see `src/auth.ts`). The matched variable's suffix, lowercased, becomes the `client_id` used in request logs (e.g. `API_KEY_FRONTEND` → `frontend`). These application keys cannot enqueue or requeue daily targets.

Production secrets, including every `API_KEY_*`, live in the 1Password vault `webops-prod`, item `yearn-price`. `.github/workflows/deploy.yml` pulls them via `1Password/load-secrets-action` and uploads them to the Cloudflare Worker with `wrangler secret bulk` on every push to `main`.

Application keys remain read-only. Queue mutation routes require the separate `DAILY_PRICE_OPERATOR_API_KEY`; when it
is not configured, enqueue and requeue remain disabled while all read APIs continue to work. Configure it independently
for local operation or with `wrangler secret put DAILY_PRICE_OPERATOR_API_KEY` in production. Do not reuse a consumer
application key for this value.

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

Pushing to `main` runs `.github/workflows/deploy.yml`: install deps, load secrets from 1Password, upload them to the Worker, run migrations, warm the price cache, then `wrangler deploy`. `.github/workflows/warmup.yml` runs the legacy spot-price warmup hourly. `.github/workflows/daily-eod.yml` owns daily EOD orchestration at 00:30 UTC: it loads the configured authoritative TVL price-target inventory, enqueues the latest closed day, records explicitly unsupported chains, and runs the durable worker through terminal outcomes. `.github/workflows/pr.yml` runs typecheck and tests on every PR.

## Testing

```bash
bun run typecheck
bun run test
```
