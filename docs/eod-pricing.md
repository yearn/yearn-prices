# Canonical EOD pricing

## Product contract

Yearn Prices maintains one canonical historical price for each supported chain, token address, and closed UTC calendar day. The key is the day's exact `23:59:59 UTC` timestamp.

Consumers use that accepted day-end price for every event in the same UTC day. They do not request event-specific prices. This choice is supported by a 46,307 asset-day validation set:

- 43,293 asset-days had an EOD price (93.49%).
- Those prices covered 69,948 of 74,199 events.
- The aggregate fee difference versus event-time valuation was -4.98 basis points.
- Median absolute price difference was 0.17%; p95 was 5.51%; p99 was 16.02%.

The service therefore optimizes for complete, explainable daily coverage rather than arbitrary timestamp reconstruction.

## Daily lifecycle

1. A UTC day closes.
2. The scheduled production cycle discovers current Yearn vault-share and underlying assets from Kong; an
   authenticated operator may also submit an explicit inventory.
3. The service converts the day to its exact `23:59:59 UTC` key.
4. Accepted exact-EOD rows are returned immediately.
5. Missing targets are inserted idempotently into `daily_price_targets`.
6. A bounded worker leases targets and resolves them outside the request path.
7. Progress remains incomplete while targets are pending, in progress, or retryable.
8. Consumers read only accepted evidence stored under the exact EOD key.

GET requests never run repair work. Intraday database rows cannot satisfy strict daily reads, and the service never substitutes a nearest stored day.

## Durable target outcomes

The queue is unique on `(chain, token, eod_at)` and records attempts, leases, retry times, completion times, adapter, precise failure reason, and structured resolver attempts.

| Outcome | Meaning | Eligible again |
| --- | --- | --- |
| `priced` | Accepted evidence was persisted before the target completed. | No |
| `unsupported` | No implemented defensible path supports the asset. | Only after an explicit code or policy change |
| `retryable` | A temporary provider, RPC, HTTP, rate-limit, configuration, or database failure occurred. | Yes, after `next_retry_at` |
| `quarantined` | A candidate or derivation failed structure, credibility, cycle, depth, or disagreement policy, or exhausted its retry budget. | Only after explicit review |

Expired `in_progress` leases are reclaimable after a process restart. Before evidence insertion, the worker locks the
complete batch and verifies every target id and attempt count. Evidence and outcomes commit in the same transaction,
so a stale worker cannot leave evidence behind. Batches use `FOR UPDATE SKIP LOCKED`, and unsupported rows cannot
starve later targets. The worker waits until controlled retry delays elapse; a retry that reaches the configured
attempt budget moves to quarantine with `failure_class: retryable` and its original transient reason preserved.

Unsupported and quarantined targets can be retried only through the operator-authenticated requeue operation. Every requeue
is limited to 500 targets, requires a human-readable reason, and is scoped either to exact asset-days or one chain/day
with optional failure-class, adapter, adapter-version, or policy-version filters. The database audit retains the
authenticated client id, scope, and complete prior outcomes before attempt state is reset.

Terminal outcomes retain the active candidate-selection policy version and the applicable historical-market or
on-chain adapter version. Version-scoped requeues therefore select the exact failed methodology recorded by the
worker rather than inferring it from the currently deployed code.

## Evidence and selection

Each stored candidate has a durable identity composed from its source, adapter, adapter version, and provider
identifier. Multiple derived adapters and reviewed methodology versions therefore coexist at the same asset-day
rather than sharing a single `derived` row. A validated candidate may replace the same quarantined identity only
after its target has passed through the audited requeue flow; accepted evidence is immutable. Each candidate
may record:

- requested chain, token, and exact EOD timestamp;
- requested and provider identifiers;
- price, symbol, confidence, source, and adapter;
- `observed`, `derived`, `estimated`, or `legacy` classification;
- `exact`, `near-eod`, `fallback`, or `legacy` quality;
- validation status and rejection reason;
- observed timestamp, historical block, and time distance;
- recursive inputs and conversion state;
- assumptions and time-bounded mapping references.

For a missing root asset-day, the worker evaluates the requested market path and every successfully applicable
on-chain adapter before selection. Recursive dependencies use their deterministic canonical path to keep the search
bounded, while every root attempt and successful candidate remains visible. Provider aliases share DefiLlama's
independence identity; distinct on-chain adapters retain distinct identities. Selection is deterministic:
classification, quality, source priority, observation distance, adapter, then candidate id. Material disagreement
between genuinely independent candidates quarantines every produced candidate; prices are never averaged.

Automatic `stable-peg` rows and unvalidated legacy rows are not eligible for strict daily selection. Missing data is unavailable, never zero.

## Recursive resolution

The worker first queries the requested chain/token identifier from DefiLlama at or before EOD. A reviewed alias is attempted only after a direct miss. Aliases and canonical-market proxies retain both identities and are classified as estimated fallback evidence. Incident proxies are rejected outside their exclusive validity interval.

If direct evidence is unavailable, the recursive engine tries historical on-chain adapters at the block at or before EOD:

- ERC-4626 `convertToAssets`;
- Yearn vault share rates;
- Compound and Iron Bank exchange rates;
- Aave underlying parity;
- wstETH conversion;
- complete-reserve AMM NAV;
- complete-reserve Curve NAV;
- Balancer V2 Vault NAV;
- Pendle LP-to-asset rates.

Every derived result retains its inputs and inherits the weakest input quality. Recursion has cycle detection and an explicit depth bound.

Pool NAV requires every constituent used by the formula. The service does not use Curve `virtual_price × coin0`, single-sided reserve ratios, or assumed stablecoin pegs.

## Production import policy

The production snapshot import is read-only: it consumes a local JSONL snapshot and never calls a production mutation.
Every price record must have an exact EOD key and a positive finite value. The original value, source, timestamp, and
snapshot provenance are retained.

Production snapshots do not preserve provider observation timestamps, so imported rows are classified as
`unknown-observation-time` and cannot serve strict reads or seed recursive pricing. Their original values and provenance
remain available as audit evidence while every asset-day stays queued for independent repair. Rows from automatic pegs,
aliases, proxies, the legacy Curve path, or undocumented derivations remain equally ineligible. A production
`stable-peg` row can never become strict EOD evidence through import.

Only evidence that explicitly preserves a verified provider observation timestamp may be enabled as a fallback
recursive seed. The current production snapshot format does not meet that requirement; its rows remain audit-only
until the worker produces complete evidence.

## Operations

Enqueue one closed day:

```bash
curl -X POST \
  -H "Authorization: Bearer $DAILY_PRICE_OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  https://prices.example/api/daily-prices/enqueue \
  --data '{"day":"2024-01-01","targets":[{"chain":"ethereum","token":"0x..."}]}'
```

The operation accepts at most 500 assets and a 128 KiB body. It normalizes addresses, deduplicates targets, and reports accepted versus queued coverage.

Run and inspect the worker:

```bash
bun run daily:run -- --batch-size 75 --concurrency 4 --max-attempts 3
bun run daily:cycle
bun run daily:status
bun run daily:canaries
bun run daily:report
```

`daily:canaries` forces representative live contracts through each registered on-chain adapter at the latest closed
EOD block, including separate Compound and Iron Bank exchange-rate cases. `daily:report` emits the final chain,
source, adapter, quality, import-policy, failure, alias, and incident-proxy breakdown without exposing provider URLs.

The authenticated progress API is `GET /api/daily-prices/progress`. The operator dashboard is `/daily-prices`; its read
key remains in browser session storage only. Queue mutation requests require the separate operator key.

Production orchestration lives in `.github/workflows/daily-eod.yml`, scheduled for 00:30 UTC. Its inventory contract is
the supported-chain vault list returned by Kong's `list/vaults?origin=yearn` route; both vault-share and underlying
addresses are deduplicated and recorded with discovery provenance. A manual workflow dispatch may select a reviewed
closed `YYYY-MM-DD` day. The cycle fails if discovery is empty or if any queue work remains non-terminal.

## Supported chains

The shared chain registry remains authoritative:

- Ethereum
- Optimism
- Gnosis
- Polygon
- Sonic
- Fantom
- Base
- Arbitrum
- Berachain
- Katana
