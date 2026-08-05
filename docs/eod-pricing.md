# Canonical EOD pricing

## Product contract

Yearn Prices maintains one canonical historical price for each supported chain, token address, and closed UTC calendar day. The key is the day's exact `23:59:59 UTC` timestamp.

Consumers use that accepted day-end price for every event in the same UTC day. They do not request event-specific
prices. In the retained Yearn Fees evaluation cohort, the existing production prices covered 40,144 of 74,199
non-zero fee transactions (54.1%) and 241 of 396 unique assets (60.9%). The strict pipeline covers 65,376 transactions
(88.1%) and 370 assets (93.4%). The service therefore optimizes for complete, explainable daily coverage rather than
arbitrary timestamp reconstruction.

## Daily lifecycle

1. A UTC day closes.
2. The scheduled production cycle consumes the configured authoritative TVL price-target inventory export; an
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

- ERC-4626 `convertToAssets`, with the standard `previewRedeem` fallback when conversion is unavailable;
- allow-listed YIP-88 liquid-locker net redemption, gated by exact-block fee, enabled status, capacity, wrapper conversion, and YFI liquidity;
- allow-listed native-asset shares using their exact `convertToAssets` or `previewRedeem` rate and the wrapped-native dependency;
- allow-listed Reserve RTokens using the exact complete redemption basket, only while unfrozen, fully collateralized, and redeemable for at least one token;
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
EOD block, including separate Compound and Iron Bank exchange-rate cases. `daily:report` emits the final chain, asset
role, source, adapter, classification, quality, terminal outcome, failure, alias, and incident-proxy breakdown without
exposing provider URLs.

The authenticated progress API is `GET /api/daily-prices/progress`. Queue mutation requests require the separate
operator key.

Production orchestration lives in `.github/workflows/daily-eod.yml`, scheduled for 00:30 UTC. Configure the repository
Actions variable `TVL_PRICE_TARGET_INVENTORY_URL` to an HTTP(S) export of the yearn-tvl-service
`tvl-price-target-inventory` schema. Schema major `1` is accepted; unknown majors fail closed. The service downloads at
most 10 MiB and never vendors a static snapshot.

Valid rows are normalized and deduplicated by chain id and address. Roles, current/historical requirements, producer
support, source state, and every vault/product origin remain in target metadata. Duplicate roles and origins are merged
in schema order, making repeated discovery for the same inventory/day deterministic and queue insertion idempotent.
Malformed target rows and producer `invalid` problems are logged explicitly; valid targets still run to terminal
outcomes before the cycle fails to alert operators.

Consumer capability is authoritative for scheduling. Gnosis chain `100` is supported by yearn-prices: it is present in
the chain registry, the production workflow loads `RPC_URL_100`, and generic historical market/on-chain resolution is
available. The two Gnosis inventory targets are therefore scheduled even while the producer artifact labels them
unsupported. HyperEVM chain `999` has no yearn-prices chain mapping, RPC configuration, or adapter support. Its two
inventory targets are retained under numeric chain key `999` and inserted directly as durable `unsupported` outcomes;
they never enter the worker and are never converted to zero. If support is later added, the producer artifact and this
policy must be updated together.

A manual workflow dispatch may select a reviewed closed `YYYY-MM-DD` day. The cycle fails if discovery is empty, if any
queue work remains pending/in-progress/retryable, or if the inventory reports malformed/invalid producer coverage.

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
