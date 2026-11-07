# Targeted historical repair

Historical maintenance now uses persisted token/day targets rather than an
hourly refresh of the whole Yearn inventory. Spot and today's historical prices
resolve live. Current observations are never used to fill closed days.

## Admission and reconciliation

Historical requests do not read or write the repair queue. Arbitrary client
misses therefore cannot create durable retry work or delay stored-price
responses with queue bookkeeping. Successful read-through observations remain
provisional and become eligible for daily reconciliation once their day closes.
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
When the budget expires, already-finalized targets are settled successfully;
all other in-flight and unstarted claims are released without changing their
attempt count, next-attempt time or last outcome. A killed process leaves its
claims recoverable through lease expiry. Lease
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
`--recent-days` controls recent Yearn discovery and the priority window (default seven closed UTC days). Due targets in that window are selected before older backlog; retry cooldowns and active leases still apply. `--recent-only` restricts claims to that window. The weekly audit instead uses an exact missing-target manifest, so unrelated recent inventory cannot consume its budget; remaining gaps still fail the audit. `--out <directory>` retains graph
evidence at a selected path; otherwise evidence goes to a temporary directory.
Structured summaries report discovery, claimed/completed/missing/unresolved/invalid/
error/deferred counts, duration and budget exhaustion. Expected unresolved graphs and a clean
runtime-budget stop do not fail the job. Rejected or implausible quotes increment
`invalid` without failing the job: unsafe prices stay unwritten, and the
coverage gap remains visible for investigation and the coverage audit.
Provider failures, missing outcome
evidence and failures of queue bookkeeping remain operational errors. Graph
cutoffs stay distinct from confirmed missing observations.

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

TypeScript checking and code review provide static validation. Tests and lint
run in GitHub CI, not locally under the repository's Astra instruction.
Migrations have not been applied to a live database.
Coverage gain and actual repair latency remain unmeasured until a live run.


### Exact audit repair

`bun run audit:prices --repair --out audit-evidence` freezes the active-vault audit scope and missing pairs, enqueues only those roots, and invokes the leased repair worker with `--manifest`. The worker still discovers child dependencies through the batched graph resolver. Existing cooldowns, parked invalid targets and active leases are respected.

The default budget is 2,400 seconds; `--repair-budget-seconds` can reduce it. Manifest work claims at most 25 roots at a time (10 at the default concurrency), reuses one provider/cache for the run, and stops starting work up to 60 seconds before the abort deadline to drain queue updates. A stuck driver still triggers the hard-stop safeguard; only the small active batch then awaits lease expiry. The parent bounds child execution and always rechecks the original scope after a child failure.

Evidence includes `before.json`, `targets.json`, `after.json`, `remaining-queue.json`, `repair/summary.json`, and per-batch graph JSONL. The CI artifact is retained for 14 days, including on audit failure. `remaining-queue.json` distinguishes due targets, cooldowns, leases, and parked/completed entries without exposing raw provider errors. A zero exit from repair alone does not assert complete coverage; the final audit determines that.
