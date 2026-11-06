# Targeted historical repair

Historical maintenance now uses persisted token/day targets rather than an
hourly refresh of the whole Yearn inventory. Spot and today's historical prices
resolve live. Current observations are never used to fill closed days.

## Admission and reconciliation

Unfiltered historical requests enqueue at most 200 distinct closed-day targets
that lack an accepted finalized price. This includes provisional observations.
Queue insertion is best effort; failures do not discard a valid price response.
Source-filtered requests retain their stored-row-only behavior.

Daily reconciliation discovers the last seven closed days of active Yearn
vaults and underlyings, plus closed provisional rows and the gap inventory.
It selects at most 10,000 unqueued candidates from each of those two database
inventories per run. Queued and finalized targets are excluded before the limit,
so old unresolved targets do not permanently hide later work. Reconciliation
preserves existing backoff and leases. Completed targets can reopen if their
accepted finalized coverage is removed or quarantined.

Completion is target-level: one accepted finalized price satisfies a token/day.
It does not require a separate observation from every provider or promote every
lower-priority provisional row when another finalized source already exists.

## Resolution and retries

Workers claim due targets atomically with leases. An expired lease is reclaimable;
an old owner cannot settle a newer claim. The default lease is 30 minutes.

Repair reuses the historical graph, observation matching, Curve plausibility
checks and transactional finalization. Provisional rows cannot satisfy repair
existence checks, become stored graph dependencies or suppress the final write.
Completion requires accepted finalized evidence in the database.

Failures persist a retry outcome and attempt count. Confirmed misses back off
from five minutes to seven days; retryable/invalid outcomes back off from one
minute to one day. The 15-minute worker cadence determines when a due target is
actually processed. Repeated API requests do not reset these deadlines. Provider
calls are batched and share exact observations within a run; Retry-After is
honored through a shared in-process cooldown.

The runtime budget aborts provider waits and stops new graph/finalization work.
A hard stop 30 seconds later bounds drivers that cannot cancel an active call.
Unprocessed work is released without charging a retry when cleanup succeeds;
a killed process leaves its claims recoverable through lease expiry. Lease
length must exceed the runtime budget by at least five minutes.

## Current-day compatibility

For today's DeFiLlama misses, an unfiltered request can try bounded Chainlink and
on-chain pricing, with Enso available when configured. The fallback preserves
source and observation provenance and writes only provisional rows. It refreshes
on request even when a previous fallback quote is stored. This replaces the
current-day derived rows previously produced by scheduled warmup.

## Commands and schedule

```sh
# Inspect discovery without mutating the queue
bun run repair:historical --reconcile

# Enqueue discovery results without running reconstruction
bun run repair:historical --reconcile --write

# Process bounded due work
bun run repair:historical --write --limit 100 --budget-seconds 600
```

Without `--write`, the worker reports queue depth without claiming targets.
`--recent-days` controls recent Yearn discovery. `--out <directory>` retains graph
evidence at a selected path; otherwise evidence goes to a temporary directory.
Structured summaries report discovery, claimed/completed/missing/error/deferred
counts, duration and budget exhaustion. Provider errors make the run fail while
retaining successful writes and retry state.

The scheduled worker runs every 15 minutes. At 00:30 UTC, daily reconciliation
runs first and a separate worker command drains due targets. Deployments do the
same after migrations. Weekly audit reconciles and checks finalized coverage
for the last seven closed days; it no longer automatically runs broad warmup.
All these jobs share the same maintenance concurrency group. GitHub schedules
do not guarantee immediate or exact-time delivery.

`warmup` and `audit:prices:backfill` remain explicit manual tools. Avoid running
manual maintenance concurrently with queue workers.

## Rollout and verification

Apply `0002_historical_repair_queue.sql` and
`0003_partial_repair_due_index.sql` through the migration workflow before
starting the new jobs. No migration or production rollout has been performed
by editing these files.

TypeScript checking and code review provide static validation. Tests, lint and
migration execution were not run under the repository's Astra instruction.
Coverage gain and actual repair latency remain unmeasured until a live run.
