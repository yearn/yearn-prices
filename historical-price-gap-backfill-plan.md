# Historical Price Gap Backfill — implementation plan

Spec: issue #26 (refines #9). Companion: read-only replay plan (comment on #26).
This document maps the spec against the current code and plans only the missing work.
Reviewed adversarially (codex gpt-5.6-sol, 2026-08-19); accepted findings are folded in,
rejected ones are noted where they touch a decision.

## What already exists (reuse, do not rewrite)

- `token_prices` schema with PK `(chain, token, timestamp, source)` and range index
  (`migrations/20260331000100-create-token-prices.js:11-24`). Matches spec section 2.
- Source-agnostic exact reads: `getExactHistoricalPrice` (`src/db/queries.ts:18`),
  `getBatchHistoricalPrices` (`src/db/queries.ts:27`), optional `source` filter,
  `DISTINCT ON` ordered by `SOURCE_PRIORITY` (`src/types.ts:1-8`:
  defillama → on-chain-oracle → bobs-api → curve → derived → defillama-alias → enso).
  Gap detection = call this path with no source filter. Reuse as-is, chunked (below).
- `insertTokenPrices` (`src/db/queries.ts:151`): today → UPDATE, closed day →
  `ON CONFLICT DO NOTHING`. Warmup callers keep it unchanged (spec compatibility tests).
- EOD normalization: `src/utils/time.ts:7-13` (`86400*floor(ts/86400)+86399`).
- Chain map `CHAIN_ID_TO_NAME` (`src/utils/chains.ts:4-15`), 10 chains.
- `normalizeTokenAddress` (`src/utils/chains.ts:33-38`): validates then EIP-55
  checksums via viem. Current writers store the checksum form; the schema does not
  enforce it and legacy casing may exist (`backfill:token-address-checksums` script is
  the remediation). DefiLlama keys use lowercase.
- Alias registry already exists: `src/sources/defillama/aliases.ts` — `ALIASES`
  array (line 58) with `{chain, token, identifier ('coingecko:…'), kind, validFrom?,
  validUntil?, incident?}`, indexed lookup (line 189), validity check
  `isDefiLlamaAliasValidAt`. This IS the spec's "reviewed alias registry" — extend it,
  do not create a parallel one. Note it validates at BOTH request and observation
  timestamps (`src/sources/defillama/alias.ts:56,76`); the backfill must keep both.
- `DefiLlamaClient` (`src/clients/defillama.ts`): `getHistorical`,
  `getBatchHistorical`, base `https://coins.llama.fi`, searchWidth default `'6h'`,
  `SlidingWindowRateLimiter(10, 1000)`.
- Retry core (`src/clients/http-client.ts`): 3 total attempts, 2 reachable delays
  (1000ms, 2000ms — the final failure throws before sleeping), retries 429/5xx only
  after an HTTP response; transport errors and aborts are not retried today.
- Warmup (`scripts/warmup-prices.ts`, cron `.github/workflows/warmup.yml`): last 7
  EODs, llama → curve → derived, writes via `insertTokenPrices`. Unchanged by this work.
- Migration tooling: db-migrate (`package.json:15-17`).
- Tests: vitest; route tests stub the Neon `Pool`; DefiLlama fixtures via `vi.fn`.

## What is missing (the actual work)

1. **`/chart` provider-contract probe, then `DefiLlamaClient.getChart`.** Nothing
   chart-shaped exists. Before freezing the client/matcher design, run a read-only
   probe of real `/chart` responses (direct address + `coingecko:` identifier) to pin:
   exact URL construction, whether `end` vs `span` are alternatives (validate one-of;
   the spec signature makes both optional), whether returned timestamps are raw
   observations or server-grid samples, inclusive/exclusive bounds, missing-sample
   shape, response-key echo. Capture these as committed fixtures. Then add
   `getChart(coins, opts)` + `DefiLlamaChartResponse` in `src/types.ts`. One coin per
   request by default.
2. **Closest-observation matcher** — alias source rejects out-of-window points
   (`src/sources/defillama/alias.ts:73-75`) but nothing selects the nearest point per
   requested EOD from a range. New pure module implementing spec section 8: structural
   validation, `abs(observed - eod)` minimization, pre-EOD wins ties, duplicate
   collapse, conflicting duplicates → `invalid_response`, outside-window → ignored.
   Takes an observation-eligibility predicate so alias date bounds apply to the
   MATCHED observation, not only the requested EOD (an in-window nearest point can
   cross a `validUntil`/incident boundary). Shared verbatim by CLI and replay
   (spec's deterministic-fixtures table demands one implementation).
3. **Manifest parser/validator** — version, chainId in chain map, EVM address (reuse
   the viem check), `ts % 86400 = 86399`, closed-day, dedupe + counts, byte-size AND
   target-count caps, SHA-256 digest of exact bytes. Identity = lowercase address;
   checksum via `normalizeTokenAddress` for `token_prices` reads/writes, lowercase
   for DefiLlama coin keys and the inventory table. Preflight: query for noncanonical
   (non-checksum) casings of manifest tokens in `token_prices` and fail visibly —
   exact-equality gap detection is wrong if legacy casing exists for a target.
4. **CLI `scripts/backfill-historical-gaps.ts`** + `package.json` script
   `backfill:historical-gaps`. Flags: `--manifest`, `--report`, `--dry-run` (default),
   `--write`. Exit codes 0/2/1 per spec section 11. Flow: validate → initial
   source-agnostic gap check (chunked: `getBatchHistoricalPrices` binds 3 params per
   target, `src/db/queries.ts:36`; chunk well under the Postgres bind limit) → group
   direct targets by token + contiguous range → chart fetch → local match → alias
   ranges for direct misses only → finalize in bounded batches.
5. **Finalization writer** — new function, NOT a change to `insertTokenPrices`
   (today-UPDATE logic and warmup compatibility forbid reuse). MUST run on one
   checked-out `PoolClient`, never `Pool.query` per statement — the Neon driver checks
   out a different connection per pool query, which would make BEGIN/LOCK/INSERT
   non-atomic (the existing `scripts/backfill-token-address-checksums.ts:119`
   `pool.query('BEGIN')` pattern is a bug to avoid, not copy). Per bounded batch, on
   the client: `BEGIN`; `SET LOCAL lock_timeout='5s'`; `SET LOCAL
   statement_timeout='30s'`; `LOCK TABLE token_prices IN SHARE ROW EXCLUSIVE MODE`
   (acquired immediately before the recheck, nothing earlier in the tx); rerun exact
   source-agnostic read (chunked); exclude now-priced targets
   (`skipped_concurrent_existing`); `INSERT … ON CONFLICT DO NOTHING RETURNING …`;
   sync inventory rows; `COMMIT`; `ROLLBACK` + release in `finally`; fresh
   client per retry. No network work inside. Bounded lock-timeout retries, then
   visible failure. Stated plainly: `SHARE ROW EXCLUSIVE` conflicts with every
   concurrent `INSERT`'s `ROW EXCLUSIVE` lock, so each batch briefly blocks warmup and
   warmup can push the backfill into its 5s lock timeout — this is the spec's design;
   batch size stays small, the canary measures wait/hold, and an integration test runs
   the writer against concurrent `insertTokenPrices` calls.
6. **`historical_price_gap_inventory` migration** — db-migrate, exact DDL from spec
   section 9 (lowercase CHECK, EOD CHECK, PK only, no extra index). Inventory sync
   rules per spec (delete on priced/inserted, upsert on unresolved). Semantics per
   spec: a snapshot "as of the latest backfill attempt" — a later warmup write can
   satisfy an inventoried gap without deleting the row, and that is fine because
   every rerun re-derives truth from the exact read. Rejected (review finding): an
   `AFTER INSERT` trigger on `token_prices` to auto-clean inventory — touches every
   writer's path, and spec non-goals bar new machinery for a table that is explicitly
   not authoritative.
7. **Structured report artifact** — one JSON per run: tool version, git revision,
   mode, manifest + alias-registry hashes, per-target records
   (`skipped_existing | inserted | skipped_concurrent_existing | unresolved`, method,
   providerIdentifier, observedTimestamp, offsetSeconds, attempts, diagnosticCodes),
   summary counts per spec section 11. Durable across mid-run death: checkpoint the
   report to a temp file after every committed batch, finalize by atomic rename; a
   fatal report distinguishes committed / unattempted / failed targets. No secrets,
   no raw payloads.
8. **Retry hardening in `http-client.ts`** — spec requires explicit request timeout
   and Retry-After honoring (capped); neither exists, and the current loop only
   retries after an HTTP response — abort/timeout, DNS, socket, and malformed-JSON
   failures bypass it. Add as OPT-IN per-request options (timeout via AbortSignal,
   Retry-After parsing with cap, retryable transport-error classification) so every
   existing caller keeps identical behavior. Keep 3 total attempts. Distinct
   diagnostic codes for timeout vs provider-response vs invalid-JSON.
9. **Replay script `scripts/replay-historical-gaps.ts`** — read-only; shares the
   production manifest parser and matcher; runs 1h/2h/6h windows; control-vs-gap
   cohorts; emits JSON + CSV; never imports insert/inventory mutation functions.
   Deliverable is the script; execution + approval is an operational gate on `--write`
   (spec section 12 allows implementation to complete before replay runs).
10. **DB integration test harness** — largest hidden scope. No real-DB tests exist
    (everything stubs `Pool`). The spec's DB test plan (lock timeouts, concurrent
    different-source guard, inventory idempotency, dry-run no-writes) cannot run
    against stubs. Wrinkle: production uses `@neondatabase/serverless`, whose
    transport needs a WebSocket endpoint — a plain local Postgres URL does not work
    through `createPool`. Plan: the finalization writer depends on a minimal
    node-postgres-compatible client interface; integration tests run it on the `pg`
    driver against dockerized Postgres (testcontainers or `docker run` +
    `DATABASE_URL`), plus one focused test of the Neon `pool.connect()` client
    lifecycle. Separate vitest project, wired into PR CI
    (`.github/workflows/pr.yml`) — a project that CI never runs is decoration.
    Rejected alternative: Neon test branches — network + credentials in CI, and
    lock-contention tests need a local controllable server. Rejected: a WebSocket
    proxy in CI — more moving parts than the interface seam.
11. **Backfill constants module** — `PROVIDER_SEARCH_WIDTH='6h'`,
    `MAXIMUM_ACCEPTED_OFFSET_SECONDS=21600`, max chart span, batch size, lock retry
    limit, manifest caps, read-chunk size. Provisional until replay; final values land
    in a follow-up commit after replay approval, before any production `--write`.

## Open questions (recommendation given; spec author should confirm)

- **`source` for alias-resolved backfill rows.** Spec section 9 says both direct and
  alias results write `source='defillama'`. The repo (post commit b4445a7, which the
  spec likely predates) has a live `'defillama-alias'` source: it is in
  `SOURCE_PRIORITY` (`src/types.ts:1-8`), stamped automatically by the source
  registry (`src/registries/source-registry.ts:60`), and written by the alias source
  (`src/sources/defillama/alias.ts:27`). Writing alias backfills as `'defillama'`
  would (a) mislabel rows against every other alias row in the table, (b) jump them
  to top priority, (c) make warmup's direct-price existence check treat an alias as a
  direct hit (`scripts/warmup-prices.ts:212`). A report file is not durable
  row-level provenance. Recommendation: persist alias matches as `'defillama-alias'`
  and amend the spec text — the spec's own rationale (provenance) argues for it.
  Needs rossgalloway's sign-off since it contradicts explicit spec wording. Gap
  detection is source-agnostic, so either choice yields `skipped_existing` correctly.
- **Alias identifier space.** Existing registry uses `coingecko:…` identifiers, valid
  DefiLlama coin keys. The `/chart` contract probe (work item 1) confirms they behave
  like `/prices/historical` before the matcher design freezes.
- **DB integration harness choice** — recommendation in work item 10; cheap to swap
  before implementation starts.
- **Read-only DB credentials for replay** — ops provisioning, not code.

## Sequencing

1. Constants + manifest parser + matcher (pure, unit-testable, no I/O). Lands alone.
2. `/chart` contract probe (read-only, produces committed fixtures) → `getChart` +
   chart types + provider contract tests. Lands alone.
3. Inventory migration. Lands alone.
4. Replay script (reuses 1–2; read-only, safe to land and run before any writer).
5. Finalization writer + DB integration harness (they justify each other).
6. CLI wiring + report artifact + retry hardening + all tests green.
7. Operational, post-merge: run replay, review, land approved constants, dry-run,
   canary, bounded batches (spec section 14). `--write` stays unused until then.

## Out of scope (spec section 4, verbatim intent)

- Manifest generation tooling (separate reviewed read-only step).
- All `daily_price_*` / canonical / evidence / correction / lease machinery.
- Any change to warmup, routes, caches, `SOURCE_PRIORITY`, or consumer contracts.
- Adapter fallbacks (Change 2) — only after replay defines unresolved cohorts.

## Test plan delta (what the repo does not yet have)

- Unit: manifest validation matrix (incl. size-cap boundaries), chain-id mapping,
  identifier construction, alias date bounds at request AND observation timestamps,
  full matcher fixture table from the replay doc (both signs, ties, duplicates,
  conflicts, out-of-window), grouping/chunking determinism, report counts.
- Provider contract: `/chart` fixtures from the probe (one-day, multi-day, sparse,
  before/after-EOD, malformed, 429, transport failure, abort/timeout); failed window
  affects only its still-missing targets; Retry-After delta-seconds, HTTP-date,
  invalid values, cap.
- DB integration (new harness): every row-state case from spec section 13, lock
  timeout behavior, the writer vs concurrent `insertTokenPrices` calls,
  no-network-in-transaction, single-client transaction atomicity, inventory
  lifecycle, dry-run performs zero writes.
- Compatibility: existing http-client callers get no timeout/Retry-After behavior
  unless opted in; retry callback contract unchanged; alias runtime source still
  writes `defillama-alias`. Rely on the existing route/cache/warmup suites for
  untouched modules — no new tests for files this work does not change.
