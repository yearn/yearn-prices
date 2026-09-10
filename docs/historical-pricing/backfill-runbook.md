# Historical graph backfill handoff

For the design and examples, see [how historical graph backfill and coverage tracking work](architecture.md).

Fill missing stored prices using the adapters already available. Further adapter
development is deferred. The input cohort is 1,071 explicit asset/day targets;
the manifest contains token addresses and dates, not wallet data.

## Scope and acceptance

- Default mode is read-only. Only `--write` changes the database.
- Use a 12-hour maximum absolute observation offset (43,200 seconds), inclusive
  on either side of the requested closed UTC day at 23:59:59.
- Historical contract state must be at or before the requested EOD. Validate
  each selected graph dependency, not merely the root's observation timestamp.
- Stored exact-day prices are reused before provider requests, including for
  dependencies. Legacy stored rows do not preserve provider observation times;
  evidence labels them as existing prices with unknown provider observation time.
- Retain the full graph artifact: reserve state, blocks, conversion inputs,
  selected route, provider observations and failure reasons.
- Only validated manifest roots are inserted. Discovered children remain in
  the evidence. Persisting every child/intermediate in issue #43 is separate work.
- Finalization rechecks the exact read under the existing bounded transaction
  lock, uses insert-only conflict handling, and clears resolved gap entries.
- Unresolved, rejected and retryable outcomes stay in the report and tracked
  inventory. This writer does not add failures to the database gap inventory.

## Team commands

Use Bun from the repository root, with the normal DATABASE_URL and RPC_URL_*
configuration in `.env`. Choose a new output path for every run. Keep generated
files together.

The JSON manifest is a local run artifact and is excluded from Git. A fresh
checkout will not contain it. Obtain the reviewed manifest from the run's
artifact bundle, or regenerate it from the requested database gaps, and place
it at the path below before running these commands.

```bash
mkdir -p backfill-runs
bun run backfill:historical-graph \
  --manifest docs/historical-pricing/backfill-manifest.json \
  --out backfill-runs/review.jsonl --dry-run --concurrency 8
```

Review `existing`, `validated`, `rejected`, `unresolved`, `evidence`, `summary`
and the final `complete` record. An interrupted file is not a completed run.
Retain the pending manifest, replay JSONL and graph JSON beside the report.

After reviewing the dry run, the team should run a small manifest canary, then
the full manifest during its chosen operational window:

```bash
bun run backfill:historical-graph \
  --manifest docs/historical-pricing/backfill-manifest.json \
  --out backfill-runs/write.jsonl --write --concurrency 8
```

This recomputes from current sources instead of importing an old candidate file.
Check successful exit and the final `complete` record. `finalized-batch` records
account for committed batches if a later batch fails. Rerunning with a new output
name skips existing prices and rechecks for concurrent writes.

## Verification after writing

1. Reconcile normalized targets against skipped, inserted, concurrent,
   rejected and unresolved results. Dry-run `would-insert` is not an insert.
2. Rerun in dry-run mode. Inserted targets should appear in the existing count.
3. Verify representative inserted dates through historical single, batch and
   range endpoints, allowing for their existing cache TTLs.
4. Merge graph evidence into the inventory and reconcile candidates against
   stored coverage. Keep provider failures retryable.
5. Stop on write failures and retain evidence. Correcting accepted historical
   rows is a separate operation.

No production backfill was executed while preparing this handoff.
