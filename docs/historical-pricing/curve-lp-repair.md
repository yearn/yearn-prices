# Curve LP incident repair (#61 and #62)

The dated manifest in `src/prices/rejected-observations-2026-10.json` contains the
28 asset-days already targeted by the repair script, including all eight yBUSD
observations in #61. It is an immutable migration input. Add later incidents in a
new migration rather than editing this snapshot.

## Containment and deployment order

1. Run migrations before deploying the new worker or starting the updated jobs.
   The normal main-branch deployment already enforces this order. Migration
   `20261015000100` seeds `rejected_price_observations`, archives the original rows
   (including price, source and timestamps) in `quarantined_token_prices`, and
   removes them from `token_prices`. It does not require archive RPC access.
2. The database trigger prevents both `defillama` and `defillama-alias` from being
   reinserted for these targets, including by an older warmup process. Rejected
   writes are archived and skipped. Application writers also reject the incident
   targets before optional RPC validation. Unknown tokens retain the generic
   guard's existing fail-open behavior; confirmed invalid observations do not.
3. Deploy the worker. Historical SQL reads exclude rejected observations before
   source priority is applied, including exact, batch, range and explicit-source
   requests. A target without another stored source returns the normal missing
   result. Source adapters and dependency validation also exclude these provider
   observations, so they cannot become inputs to new derived prices.
4. The worker uses historical edge-cache revision `2026-10-quarantine-v1` for
   every exact, batch and range cache key, including source-filtered combinations.
   Pre-incident Cache API entries become unreachable on deployment. New complete
   closed-day responses use `public, s-maxage=2592000, max-age=3600`.
   Subsequent repairs must bump `HISTORICAL_CACHE_REVISION` to become visible at the edge.

Previously delivered browser or downstream immutable responses cannot be
revoked by a worker deployment. Consumers must purge their own saved responses
or re-fetch with `revision=2026-10-quarantine-v1` appended to the public URL,
including batch/range and source-filtered URLs. Keep using this revision on those
URLs while refreshing affected TVL/reference-price data. This query parameter is
accepted by existing routes and gives downstream caches a new URL. Internal
`_price_cache_revision` is controlled by the worker and cannot opt back into an
old cache. Do not claim the incident is resolved until consumer refresh and API
verification are complete.

## Dated replacement prices

With the normal database and archive `RPC_URL_1` configuration, capture a dry run:

```bash
bun run scripts/repair-curve-lp-outliers.ts > curve-lp-dry-run.jsonl
```

Review each target's status and the full derived path, including historical block,
Curve reserves, supply, and constituent prices. Replacements must come from the
Curve reserve adapter at the requested date; later prices are never copied back.
A separate read budget is used for each target. No new DefiLlama HTTP calls are
made by this repair: constituent market prices come from accepted stored rows,
and the existing adapters resolve conversions on chain.

Apply the reviewed repair with:

```bash
bun run scripts/repair-curve-lp-outliers.ts --write > curve-lp-write.jsonl
```

Quarantine commits before RPC work. An unavailable replacement leaves a gap and
exits nonzero, while the rejected payload remains in the quarantine archive.
Rerunning retries targets with no replacement even though their original provider
rows have already been removed. Existing accepted prices are preserved. The
manifest's delete-only yETH target remains a gap unless an accepted source exists.

The quarantine migration deliberately has no automatic rollback that could make
invalid prices selectable again. Releasing a provider target requires a reviewed
forward migration and a corresponding application-policy change, backed by new
historical evidence.

## Verify after deployment and repair

For the eight yBUSD timestamps below, compare stored accepted rows with the exact,
batch and range APIs using default selection and `source=defillama`,
`source=defillama-alias`, `source=curve`, and `source=derived`:

```text
1780444799 1780531199 1780617599 1780703999
1780790399 1780876799 1780963199 1781049599
```

The LP is `ethereum:0x3b3ac5386837dc563660fb6a0937dfaa5924333b`. The two rejected
provider filters must return 404 for exact requests and omit the observations
from batch/range. Default selection must use an accepted replacement or report
missing; `curve`/`derived` must match the corresponding stored source. Inspect
both normal server requests and consumer re-fetches with the public revision.
Retain the JSONL repair evidence and invalidate/recollect affected downstream
constant-price reference and TVL observations before closing #61.

Regression cases are in `test/integration/price-quarantine.integration.test.ts`,
`test/scripts/repair-curve-lp.test.ts`, and the source, finalization and cache tests.
