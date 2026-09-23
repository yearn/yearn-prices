# How historical graph backfill and coverage tracking work

The historical pricing system has three responsibilities: reconstruct prices
from historical evidence, persist validated results, and explain unresolved
dependencies. The backfill runner coordinates reconstruction and persistence;
the coverage tools identify the assets and dates blocking calculations.

The historical API reads stored prices. Dependency discovery and price
reconstruction run in offline jobs, outside the API request path.

For operational commands, see the [backfill runbook](backfill-runbook.md).
For inventory and report commands, see the [coverage guide](README.md).

## The shared dependency graph

An adapter calculates a parent asset from its child prices and historical
contract state. For example, a vault share can depend on an LP token, which in
turn depends on two constituent prices:

```text
Vault share @ day D
└── LP token @ day D
    ├── Token A @ day D
    └── Token B @ day D
```

The scheduler acquires those inputs across a whole
historical workload. Resolving roots individually can discover one child,
fetch it, discover another, and fetch again. A batch client helps, but small
groups of requests discovered at different times still produce many calls.

The graph scheduler collects dependencies across roots. Two pools that need the
same underlying price can share that work:

```text
Pool A @ day D ──┬── USDC @ day D
                └── Wrapper X @ day D ── Token Y @ day D

Pool B @ day D ───── USDC @ day D
```

It is a graph rather than a collection of independent trees. Node identity
includes chain, token, timestamp and any pinned historical block. Different
block contexts remain distinct for on-chain calculations; database and provider
lookups can share their exact token/timestamp cache across those contexts.

An adapter's discovery step captures historical state and a calculation plan.
For a pool, that can include reserves, supply and constituent identities. The
plan declares the child prices needed to calculate the result. It does not
require those prices to be available before describing the dependencies.

## Discovery proceeds in frontiers

A frontier is the group of newly discovered targets ready to investigate.
The scheduler repeats these steps:

1. Prefetch stored exact-day prices for the frontier.
2. Batch direct provider lookups for targets still missing a stored price.
3. For nodes without a usable market price, ask adapters to discover historical
   calculation plans and their dependencies.
4. Deduplicate newly discovered children into the next frontier.

This is incremental discovery: the runner does not build the entire graph
before making any provider requests. It batches each known frontier, and a node
with a usable market price does not need adapter decomposition. Alias lookups
can also be discovered during market resolution.

DeFiLlama requests use shared batching, caching, pacing and cooldown handling.
Repeated token/timestamp requests reuse results, including confirmed misses.
A successful empty response establishes missing provider coverage; a timeout,
429, malformed response or server error remains a failure that may be retried.
Batching reduces traffic but does not remove provider quotas.

Once discovery finishes, the scheduler evaluates captured plans from children
toward parents. This evaluation uses the captured state without repeating RPC
discovery. A parent can resolve once all inputs for a valid route are available.
Alternative routes can be considered, while selected paths must avoid cycles.
Depth, node and RPC read budgets keep discovery bounded; hitting a limit is
recorded rather than treated as proof that an asset has no pricing route.

## A calculated price must pass validation before writing

The writer reads an explicit manifest of asset/day targets and skips roots
already stored. For each calculated root, it validates the selected dependency
path, including:

- Matching chain, token and requested timestamp, with finite positive prices.
- Provider observations within an inclusive 6-hour offset on either side of
  the requested EOD timestamp.
- Historical block evidence at or before EOD, within the accepted window, and
  consistent with any pinned block.
- Complete route dependencies and matching input-price evidence.

Checking every selected child matters: a root's summarized observation
timestamp alone could hide an out-of-window constituent price.

Existing database prices are accepted as stored history. Legacy rows do not
carry the original provider observation timestamp; their evidence explicitly
records that limitation. Reusing one does not recover its missing provenance.

Dry-run mode performs resolution and validation without inserting prices.
Write mode passes validated results to a finalizer that rechecks for concurrent
inserts and uses insert-only conflict handling. Only validated
manifest roots are written. Discovered children and intermediate calculations
remain in the evidence; this is not a writer for every graph node.

The report records validated candidates, unresolved roots, rejected candidates
and finalized batches; the graph retains the supporting routes and input
evidence. A final `complete` record identifies a completed run. Finalization is
batched, so an interrupted write run can contain both committed batches and
unprocessed targets.

## Coverage tracking finds the assets that need work

Coverage tracking has three connected components.

**The inventory merger** retains asset/day observations across runs, keyed by
chain and token, with run identity and failure evidence. It distinguishes an
asset needing its own pricing investigation from a parent blocked only by
children. Repeated runs are idempotent, and one run ID cannot identify different
evidence.

**The historical availability scan** investigates whether each asset has usable
prices elsewhere in history. It combines stored history, batched provider
history and validated graph evidence on the dates actually replayed. It does
not run every adapter on every historical day. Failed windows leave the
investigation incomplete.

**The post-backfill report** starts with unresolved roots from a completed run
and follows viable dependency routes to their blockers. It excludes roots
already resolved by that run and unused graph branches.

For example:

```text
Vault A @ Jan 10 ─┐
Vault B @ Jan 10 ─┼── ibJPY @ Jan 10: missing
Curve LP @ Jan 10 ┘
```

If those parent routes are otherwise usable, ibJPY is the pricing task. Listing
all three parents as additional unsupported assets would obscure the common
cause. This classification follows graph evidence, not token names or suffixes.
A pool with its own discovery error can still need investigation.

## Post-backfill report semantics

The report is a projection derived from a specific completed backfill run.
Its unresolved set comes from that run's outcomes. Successful resolutions are
excluded from the remaining work even when the input run was a dry run and
therefore did not persist them. This separates the question “can this run
resolve the price?” from “is the price stored in the database?”

The report traces unresolved roots to the assets requiring their own pricing
work and deduplicates their missing dates. A single root can depend on several
missing asset/day inputs, and several roots can share one input. Root counts
and missing-input counts therefore measure different things.

Historical availability is a separate dimension. A price found only by the
wider research scan does not remove a date from the completed run's unresolved
set. It supplies evidence for further resolution, not a result of that run.

The report combines the unresolved set with its position relative to known
historical observations:

| Field | Meaning |
|---|---|
| Remaining dates | Number of distinct dates still needing a price for this asset |
| Known historical range | First and last usable price dates found in the investigation |
| Before | A remaining date precedes the first known price |
| Interior | A remaining date lies within the known range, including its endpoints |
| After | A remaining date follows the last known price |
| No known history | The investigation found no usable historical range |

Multiple position labels mean different remaining dates fall in different
parts of the range. None of these labels means a gap is resolved. Positions
are provisional when the historical scan is incomplete, and “no known history”
does not prove that an asset never had a price or economic value.

The broader research output can label a requested date “now-covered” when it
finds an observation. That research label is deliberately absent from the main
post-backfill report because it does not establish success in the completed
backfill.

## Curve quote fallback and graph plans

Curve's recursive resolver can value an unsupported constituent through a
historical `get_dy` quote against a priced reserve, subject to executable
liquidity checks. Transient or invalid child failures do not qualify for that
fallback. The graph plan requires prices for every constituent and evaluates
without additional RPC calls. It does not capture the conditional `get_dy`
fallback, so a recursive Curve result may be available while its graph result
remains unresolved. Both paths share pool discovery, reserve accounting and NAV
calculation.

## Evidence and storage boundaries

The database is authoritative for persisted prices. A graph artifact describes
calculation paths and their evidence; a run report describes execution outcomes;
an inventory aggregates observations across runs. These artifacts serve
different purposes and do not independently establish database persistence.

Historical availability describes observations found within the investigated
scope. It is not an exhaustive lifetime replay of every adapter. Missing
observations, unavailable dependencies, provider failures and discovery limits
remain distinct outcomes. The system does not fill gaps through interpolation,
assumed pegs or spot-price substitutions.
