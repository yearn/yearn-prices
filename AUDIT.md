# Price service codebase audit

Date: 2026-11-03. Revision: `d31bc4cb3068d68c2030c1416a9bfe7f373ce43f`.

Scope: repository-wide static audit of maintainability, performance, reliability, data integrity, correctness, and bugs. The working tree was clean when the audit began. This reviews current behavior, not only the latest commit. No implementation changes were made during the original audit. The remediation below was implemented afterward.

## Remediation — 2026-11-03

Implementation was coordinated across Luna agents and is kept together on the single `audit/remediation` branch for pull request review. No deployments or production data changes were made. The original findings and line references below describe the pre-fix revision.

| Findings | Implemented changes |
| --- | --- |
| A01–A03 | Explicit provisional/finalized state, guarded closed-day finalization, observation provenance, positive-price validation at matcher/writer/database boundaries, and validated Curve dependencies. Warmup retains request-time intent across midnight. |
| A04–A07, A15 | Reject ambiguous normalized aliases before cache lookup; restore caller casing on cache hits; prevent caching retryable spot failures; bound spot resolution to 15 seconds and Enso attempts to 4 seconds; validate timestamp bounds as input errors. |
| A08–A11 | Batched offline transport with shared exact observation cache, shared full Retry-After cooldown including terminal 429s, historical-context LP discovery caching, and malformed chart observation rejection. |
| A12–A14 | Quarantine-aware coverage, authoritative final target-outcome reconciliation, and nonzero repair exits on failed prices or verification mismatches. Derived repair stops after price-phase failures. |
| Related compatibility | Preserve finalization/provenance during checksum repairs and graph writes, bump historical edge-cache revision, and correct README cache TTL documentation. |

### Deployment and residual limits

Apply migration `drizzle/0001_finalize_token_prices.sql` (`bun run migrate`) before deploying the worker or running updated jobs. It adds finalization/provenance columns and a finite-positive price constraint, quarantining pre-existing invalid prices first. Its rollback is deliberately forward-only. The migration was exercised only against disposable test databases.

Pre-migration closed-day rows have unknown original observation times. The migration preserves those rows as finalized; it cannot determine which were originally provisional. Existing affected history therefore still needs an evidence-backed repair. Current-day rows are marked provisional at migration time. No production history was repaired as part of this work.

Spot cancellation stops queued provider work and new recursive work. An already-dispatched viem RPC remains bounded by its transport timeout because its per-call API does not expose an abort signal. Browser/downstream cache entries already delivered cannot be evicted by an edge revision bump.

The original open questions about LP fail-open policy, the legacy Curve valuation assumption, production query performance, and protocol-specific economic validation remain. No live provider benchmark, production database inspection, or deployment was performed. Day-alignment failure outcomes are verified through mocked phase actions rather than a production repair run.

### Remediation verification

- `bun run test`: 78 files, 660 tests passed.
- `bun run test:integration`: 4 files, 41 tests passed against disposable Postgres, including migration application, provisional-to-finalized transition, immutable finalized rows, closed provisional read filtering, and the in-flight midnight boundary.
- `bun run typecheck`: passed.
- `bun run lint`: passed (235 files checked).
- `git diff --check`: passed.

A separate Luna review identified the midnight boundary and cancellation follow-ups; these were implemented before the combined checks. Checks use mocks/local databases and do not establish production data correctness or provider performance.

## Original findings

**15 findings: 2 High, 12 Medium, 1 Low.** These are code-supported failure paths; this audit does not establish that the triggering conditions have occurred in production. Walkthroughs below are analytical, not executed reproductions.

| ID | Severity | Finding | Main concerns |
| --- | --- | --- | --- |
| A01 | High | Provisional intraday prices are never finalized after midnight | Data integrity, correctness |
| A02 | High | The scheduled writer accepts zero and negative prices | Data integrity, correctness |
| A03 | Medium | Legacy Curve fallback discards constituent observation validation | Data integrity, correctness |
| A04 | Medium | Cache normalization collapses different historical request sets | Correctness, bugs |
| A05 | Medium | Shared cache entries return another request's token-key casing | Correctness, compatibility |
| A06 | Medium | Retryable spot failures receive the successful-response cache policy | Reliability |
| A07 | Medium | One stalled Enso lookup can hold the entire spot response | Reliability, performance |
| A08 | Medium | Scheduled and legacy jobs bypass shared provider controls | Reliability, performance, maintainability |
| A09 | Medium | The final 429 does not extend the shared cooldown | Reliability |
| A10 | Medium | Historical LP discovery is cached without its historical context | Data integrity, correctness |
| A11 | Medium | Malformed chart observations can become confirmed misses | Reliability, data integrity |
| A12 | Medium | Coverage analysis counts quarantined provider observations as usable | Data integrity, correctness |
| A13 | Medium | Post-backfill reporting omits finalization rejections | Correctness, reliability |
| A14 | Medium | Day-alignment repair can exit successfully after failed repairs | Reliability, operations |
| A15 | Low | Out-of-range timestamps produce internal errors instead of input errors | Correctness, observability |

### A01 — High: Provisional intraday prices are never finalized after midnight

Evidence: `src/utils/time.ts:34`; `src/sources/defillama/batch.ts:32`; `src/sources/defillama/match.ts:88`; `scripts/warmup-prices.ts:195`, `:280`, `:337`, `:470`; `src/db/queries.ts:185`; `scripts/lib/graph-backfill.ts:63`.

Today's DeFiLlama request is converted to the current time, but its result is stored under today's 23:59:59 key. Warmup refreshes existing rows only while their timestamp belongs to today. Once midnight passes, the direct stage skips that key, and the Chainlink, Curve, and derived stages likewise skip their existing closed-day rows. The database helper also changes from updating conflicts to `DO NOTHING`. Graph backfill skips roots with any accepted stored price, so the daily graph run does not finalize these rows.

**Failure scenario:** the last successful warmup on day D records a 23:00 quote. The next run, on D+1, finds the row for D and leaves it unchanged even if a closer closing observation is now available. If later hourly runs failed, the permanently retained quote can be much older. Derived vault prices retain their earlier conversion state as well.

**Impact:** historical results labeled as daily closing prices can permanently contain provisional intraday values. Coverage checks see a row and cannot detect the problem.

**Suggested fix:** represent provisional versus finalized prices explicitly. After a day closes, fetch and validate its final observations and refresh affected derived prices before marking the day finalized. Preserve observation times so finalization can be audited and retried. Do not rely on the wall clock alone to decide immutability.

**Verification to add:** a clock-controlled writer scenario spanning midnight, including a failed final hourly run and a later successful finalization. Existing insertion tests verify today's mutability and past-day immutability separately, but do not verify the transition.

### A02 — High: The scheduled writer accepts zero and negative prices

Evidence: `src/sources/defillama/match.ts:27`, `:78`, `:92`; `scripts/warmup-prices.ts:231`, `:240`, `:510`; `src/db/queries.ts:192`, `:201`; `migrations/20260331000100-create-token-prices.js:16`; compare `src/sources/base.ts:17`.

The shared sample matcher checks finiteness but does not require a positive price. `buildDefiLlamaWrites` copies the selected value directly into a write. Warmup calls that function without the positive-price filter used by the historical source wrapper. The LP plausibility guard is an upper-bound check and does not reject zero or negative quotes; ordinary non-LP tokens pass it. Neither `insertTokenPrices` nor the table schema enforces the finite-positive rule.

**Failure scenario:** a well-formed batch observation contains `{ timestamp: requestedTime, price: 0 }`. It becomes a stored `defillama` row. A negative finite price follows the same path. Warmup can then multiply that price by a vault share conversion and persist a bad `derived` row.

**Impact:** the API selects these rows, and source-agnostic gap detection treats them as coverage. Closed-day conflict behavior makes ordinary reruns unable to correct them.

**Suggested fix:** enforce a common price/timestamp invariant at ingestion and at the write boundary. Add database constraints after identifying and quarantining existing violations. Retain invalid observations as diagnostic failures rather than replacing them with zero or silently accepting them.

**Verification to add:** zero and negative batch observations through the actual warmup write path; invalid derived results; confirmation that invalid stored prices cannot satisfy coverage reads.

### A03 — Medium: Legacy Curve fallback discards constituent observation validation

Evidence: `scripts/warmup-prices.ts:351`, `:357`, `:366`; `src/clients/curve.ts:124`; compare `src/sources/defillama/alias.ts:73` and `src/backfill/graph-validation.ts:39`.

The Curve fallback callback reads `response.coins[coinKey]?.price` and discards the observation timestamp and provenance. It does not apply the six-hour matcher or the incident rejection manifest to the constituent. The resulting LP value is written with the requested day and source `curve`, which is outside the provider-source quarantine predicate.

**Failure scenario:** the provider returns a finite positive constituent quote outside the requested window. The callback accepts it and combines it with the pool's historical virtual price. The same bypass exists for a constituent/day explicitly rejected for the DeFiLlama source. The alias implementation already documents and guards against providers returning observations outside `searchWidth`; merely sending that parameter is insufficient.

**Impact:** an apparently dated on-chain result can contain a stale or rejected market dependency. Its new source label hides the dependency from the existing rejection filter.

**Suggested fix:** use a validated market-resolution result that retains the observation timestamp and source, applies quarantine checks, and validates every consumed dependency before writing. Prefer the shared historical adapter path over maintaining a less strict second Curve writer.

**Verification to add:** out-of-window and quarantined constituent responses must not produce a Curve row.

### A04 — Medium: Cache normalization collapses different historical request sets

Evidence: `src/cache/edge.ts:66`, `:87`, `:98`; `src/utils/validation.ts:84`, `:134`; `src/index.ts:88`.

The parsers accept multiple JSON object keys that normalize to the same chain/token and retain the work from each entry. Cache canonicalization lowercases the object keys using assignment, so the last sorted alias overwrites earlier entries instead of merging or rejecting them.

**Failure scenario:** let `Kupper` and `Klower` be differently cased spellings of the same valid token key, and D1 and D2 be different normalized days. The payload `{ Kupper: [D1], Klower: [D2] }` requests both days but canonicalizes to the same cache key as `{ Klower: [D2] }`. Either response can therefore be served for the other request. Range payloads have the same overwrite behavior. Because range validation occurs after cache lookup, an invalid overwritten entry can also be hidden by an already cached valid entry.

**Impact:** batch/range responses can omit requested days or include unrequested days, with the historical cache TTL extending the inconsistency.

**Suggested fix:** build one validated normalized request representation and use it for both execution and cache keys. Reject duplicate normalized token keys, or merge their requests under an explicit rule. Validate every entry before cache lookup.

**Verification to add:** populate the cache with each of the two payloads in turn and read with the other; cover duplicate case aliases in ranges and an invalid overwritten range entry.

### A05 — Medium: Shared cache entries return another request's token-key casing

Evidence: `src/cache/edge.ts:53`, `:101`, `:106`, `:129`; `src/routes/spot.ts:37`, `:56`; `src/routes/historical/shared.ts:9`, `:33`; `src/index.ts:94`.

The cache deliberately shares entries across casing variations, while handlers preserve the requesting caller's original token key in the response. Cache hits return the stored response verbatim.

**Failure scenario:** a checksummed spot request fills the cache. A lowercase request then receives a response whose `coins` object contains the checksummed key. The same lowercase request on a cold cache would return a lowercase key. Historical batch and range responses have the same issue. The exact historical route does not share these casing-normalized path keys and is not part of this finding.

**Impact:** clients looking up `coins[requestedKey]` can fail depending on which caller populated the cache first.

**Suggested fix:** choose a consistent response-key contract. Either always return canonical keys, reconstruct caller-specific keys from cached normalized data, or include the response-affecting casing in the cache identity.

**Verification to add:** compare cold and warm responses for differently cased requests with nonempty bodies. Existing cache tests establish key equality but use an empty `coins` body in the cross-casing read/write case.

### A06 — Medium: Retryable spot failures receive the successful-response cache policy

Evidence: `src/routes/spot.ts:34`, `:48`, `:69`; `src/cache/headers.ts:21`; `src/index.ts:98`.

Spot resolution converts rejected token promises into per-token `UNAVAILABLE` values, then returns HTTP 200 with `CACHE_CONTROL_SPOT` unconditionally. The worker consequently offers these responses to the shared cache, including a response where every token failed transiently.

**Failure scenario:** an Enso transport failure and unavailable fallback produce `UNAVAILABLE`. A retry after the provider recovers reads the cached error body instead of attempting resolution again, for the configured 120-second edge TTL. Downstream caches also receive a stale-while-revalidate directive.

**Impact:** a brief provider outage becomes a longer user-visible outage. The top-level error handler's `no-store` policy does not apply to these per-token errors.

**Suggested fix:** make cache policy depend on token outcomes. Responses containing retryable errors should use `no-store`, or cache successful token values separately while allowing failed tokens to retry. Stable missing-price responses can have their own deliberate policy.

**Verification to add:** transient failure, provider recovery, and immediate repeat request through the worker/cache boundary.

### A07 — Medium: One stalled Enso lookup can hold the entire spot response

Evidence: `src/clients/enso.ts:18`; `src/clients/http-client.ts:100`, `:122`, `:152`, `:160`; `src/routes/spot.ts:18`; `src/registries/source-registry.ts:68`.

Enso does not configure `timeoutMs`, so its fetch has no application abort deadline. The spot route waits for every token through `Promise.allSettled`, and a fallback source is tried only after the preceding source settles. There is also no route-wide deadline covering time spent waiting for the shared rate limiter.

**Failure scenario:** one upstream connection or response body stalls while the other token prices have completed. The entire response remains pending, and the stalled token cannot reach its on-chain fallback. A large queue of concurrent requests can add an unbounded application-level wait before fetch even starts.

**Impact:** one slow token delays otherwise usable results and retains queued work. Request size limits and RPC read budgets do not bound this wall-clock behavior.

**Suggested fix:** apply a per-attempt timeout plus an overall request deadline that includes queueing, retries, and fallback work. Abort expired work and return settled token results with retryable errors for unfinished tokens.

**Verification to add:** stalled headers, stalled JSON body, and rate-limiter queue saturation with another token successfully resolved.

### A08 — Medium: Scheduled and legacy jobs bypass shared provider controls

Evidence: `scripts/warmup-prices.ts:63`, `:223`, `:357`; `scripts/backfill-defillama-day-alignment.ts:121`, `:579`; `scripts/backfill-historical-gaps.ts:644`; `src/backfill/constants.ts:23`; compare `scripts/lib/offline-provider.ts:4`.

Warmup constructs the default DeFiLlama client, whose options do not enable timeouts or `Retry-After`. The initial direct stage is batched and concurrency-bounded, but its legacy Curve stage performs a fresh single-coin HTTP lookup for each pool/day without a run-wide exact lookup cache. The day-alignment repair also constructs the default client, and its verification loop issues single-token requests for a known set. The older chart backfill caps `Retry-After` at 60 seconds and has no shared cooldown across requests.

**Failure scenario:** a provider requests a multi-minute pause. Warmup retries on its ordinary short backoff while sibling batches continue. Repeated pools using the same constituent/day repeat the HTTP work. The older chart path resumes after at most a minute even when a longer cooldown was requested.

**Impact:** avoidable provider traffic, repeated rate limits, and long-running or workflow-timed-out jobs. These paths violate the repository's explicit offline batching and shared-cooldown requirements even though newer graph tooling has most of the required machinery.

**Suggested fix:** consolidate provider scheduling, observation validation, and exact lookup caching across offline writers. Coalesce discovered Curve dependencies into batches. Use a today-compatible batched implementation for intraday warmup; the existing `BatchedHistoricalClient` intentionally accepts only closed-day EOD targets and cannot simply replace every warmup call unchanged.

**Verification to add:** shared constituent deduplication and a long `Retry-After` blocking every new request, including requests from sibling batches.

### A09 — Medium: The final 429 does not extend the shared cooldown

Evidence: `src/clients/http-client.ts:124`, `:191`, `:202`; `scripts/lib/offline-provider.ts:17`; `scripts/lib/batched-historical-client.ts:125`.

The shared cooldown is extended only from `onRetry`. On the last HTTP attempt, `fetchJsonWithRetry` throws before parsing `Retry-After` or invoking that callback. The batching client catches the failed batch and proceeds to the next batch.

**Failure scenario:** attempts one and two receive 429 responses and wait correctly. Attempt three receives another 429 with a fresh long cooldown. The prior cooldown has expired, and this response does not extend it, so the next queued batch can be sent immediately, subject only to ordinary rate pacing.

**Impact:** even jobs using the shared offline provider violate the server's cooldown precisely when throttling persists.

**Suggested fix:** update provider-wide throttle state on every rate-limit response, including terminal failures, independently of whether that particular request will retry. Keep retry-count telemetry separate from response/throttle telemetry.

**Verification to add:** three consecutive 429s followed by another queued batch; verify no new HTTP request occurs before the third response's cooldown expires. Existing cooldown tests cover retried responses, not the exhausted-attempt branch.

### A10 — Medium: Historical LP discovery is cached without its historical context

Evidence: `src/sources/defillama/lp-guard.ts:27`, `:32`, `:38`, `:54`; `src/sources/onchain/adapters/curve.ts` (`resolveCurvePoolCoins`).

`poolFor` discovers the pool and its coins at a specific timestamp/block, but caches the result by chain and token only. Fulfilled null results are retained; only rejected promises are evicted.

**Failure scenario:** the first requested day predates pool deployment, so discovery returns null. A later day in the same run, after deployment, reuses that null and immediately passes the quote without performing an LP bound check. Historical changes to pool/coin identity can likewise reuse the wrong discovery state. Multi-day warmup and repair runs share one guard instance.

**Impact:** whether a suspicious quote receives validation depends on which day was processed first.

**Suggested fix:** include the historical block or exact timestamp in the discovery cache identity. If any token-level metadata is shared across dates, separate and prove that metadata's invariance; do not share historical absence across dates.

**Verification to add:** the same LP before and after deployment, in both processing orders, with an implausible post-deployment quote.

### A11 — Medium: Malformed chart observations can become confirmed misses

Evidence: `src/backfill/chart-envelope.ts:17`; `src/backfill/matcher.ts:38`, `:75`, `:106`; `scripts/backfill-historical-gaps.ts:319`; compare `scripts/lib/batched-historical-client.ts:139`.

The envelope reader recognizes an explicitly present coin entry but does not validate its shape. `matchChartObservation` classifies null, scalar, or array coin values as `not_found`. Within a `prices` array, malformed entries are skipped, and an array containing only invalid entries also becomes `not_found`.

**Failure scenario:** HTTP 200 returns a present coin with `{ prices: [{ timestamp: "bad", price: 123 }] }`, or a null coin value. The backfill records a missing observation rather than an invalid provider response. No malformed-response diagnostic survives to distinguish this from a successful empty result.

**Impact:** diagnostics and unresolved-inventory decisions overstate evidence of absence and understate provider failures. A future run may retry the gap, but the current run has already lost the required distinction.

**Suggested fix:** preserve whether the coin key was absent versus present-but-malformed. Track invalid observations independently of window/eligibility filtering; when malformed content prevents a trustworthy result, return `invalid_response` rather than `not_found`.

**Verification to add:** present null/scalar entries and nonempty arrays with no structurally valid samples. Existing matcher tests intentionally allow a valid sample alongside malformed ones; that does not justify declaring an all-malformed payload a confirmed miss.

### A12 — Medium: Coverage analysis counts quarantined provider observations as usable

Evidence: `scripts/analyze-historical-coverage.ts:220`, `:272`, `:276`, `:287`; `src/prices/rejections.ts:13`; `src/backfill/coverage.ts` (`validateCoverageChart`).

The coverage scan validates response structure, positive prices, and matching windows, then adds direct and eligible alias observations to its covered-day set. It never applies `isRejectedPrice` to these provider observations. A known incorrect but finite positive observation therefore passes the scan even though normal historical sources and graph validation reject that token/day/source.

**Failure scenario:** DeFiLlama continues to return one of the observations listed in the incident manifest. The coverage scan counts its day in `providerDays`, `usableRanges`, and the combined coverage classification.

**Impact:** research output can label known-bad evidence as usable and obscure the need for replacement pricing. This path does not write database prices, so the direct impact is misleading investigation and repair guidance.

**Suggested fix:** apply the incident filter to every target/day before direct or alias observations establish coverage. Record quarantined observations separately. Apply the accepted-row predicate to database coverage reads as a consistency safeguard as well.

**Verification to add:** a finite positive observation for a manifest-rejected day must remain uncovered unless an independent accepted source covers it.

### A13 — Medium: Post-backfill reporting omits finalization rejections

Evidence: `scripts/report-post-backfill.ts:23`, `:42`, `:56`, `:93`; `scripts/lib/graph-backfill.ts:141`, `:163`; `src/backfill/finalize.ts:369`.

The report derives missing roots only from records whose top-level type is `unresolved` or `rejected`. A quote rejected by the finalization plausibility guard is instead emitted as a `target-outcome` with status `rejected_implausible`, plus a finalized-batch result. The summary counts those rejections separately from `unresolved`, so the report's accounting check does not detect the omission.

**Failure scenario:** a one-target run validates its graph, then rejects the quote as implausible at finalization. Its summary has zero inserted, zero unresolved, and one rejected-implausible target. The post-backfill report can still report zero remaining original targets and require no unresolved evidence inputs.

**Impact:** the human review artifact can imply no remaining work while no usable price was written for the target.

**Suggested fix:** project final outcomes from the authoritative per-target status records, including every unresolved/rejected status. Assert that all normalized targets reconcile across existing, inserted/projected, concurrent, and remaining outcomes. Finalization-rejected roots need a reporting path even though their graph still contains a candidate price.

**Verification to add:** a completed run containing only a plausibility rejection, plus a mixed run with successful and rejected finalization results.

### A14 — Medium: Day-alignment repair can exit successfully after failed repairs

Evidence: `scripts/backfill-defillama-day-alignment.ts:289`, `:315`, `:323`, `:348`, `:586`, `:593`.

Per-token provider and database errors are caught, appended to `report.failed`, and logged, but `repairPrices` returns normally even when `failedTokens` is nonempty. The top-level exit code changes only for an exception that escapes. The `verify` phase similarly prints `MISMATCH` without failing the process. In `all` mode the derived phase proceeds after a partially failed prices phase.

**Failure scenario:** a provider batch or transactional write fails for one token while the script finishes processing the rest. The report contains failures, yet the shell receives a successful exit. A verification mismatch has the same successful exit behavior.

**Impact:** operators and automation cannot use process success as evidence that repair or verification succeeded; subsequent steps can run against a partially repaired dataset.

**Suggested fix:** preserve the report and return a nonzero aggregate status for failed repairs or verification mismatches. Make the decision to continue derived repair after partial failure explicit. Retain successful progress for safe reruns.

**Verification to add:** an isolated provider failure, a write failure, and a verification mismatch each produce a nonzero exit while preserving diagnostic output.

### A15 — Low: Out-of-range timestamps produce internal errors instead of input errors

Evidence: `src/utils/validation.ts:13`, `:95`, `:137`; `src/utils/time.ts:7`, `:50`; `src/index.ts:124`.

HTTP parsers accept digit strings or numeric values without checking safe-integer and representable-date bounds. A sufficiently large numeric timestamp remains finite during normalization but causes `Date.toISOString` to throw later. Numeric overflow instead throws a plain error in `normalizeToEndOfDay`. Both reach the generic HTTP 500 path.

**Failure scenario:** an authenticated exact request uses the timestamp segment `100000000000000000000`, or a batch includes a JSON numeric literal such as `1e309`. These inputs do not produce the documented `INVALID_INPUT` response.

**Impact:** invalid client input appears as a server incident and reaches error telemetry; client behavior differs across equivalent invalid forms.

**Suggested fix:** centralize supported timestamp validation before normalization and serialization, and throw `ApiError('INVALID_INPUT', ...)` for invalid values. Decide explicitly whether fractional, negative, and future timestamps are supported.

**Verification to add:** overflow, finite values outside the Date range, and boundary values through all historical parsers.

## Open questions and residual risks

- **LP validation deliberately fails open.** `src/sources/defillama/lp-guard.ts:44` and `:83`, plus its tests, explicitly accept quotes when RPC, virtual-price, or constituent-price evidence is unavailable. This is an established policy, not an accidental exception-handling defect. Decide whether an unverified quote should be persisted immutably or remain provisional/retryable, especially given A01. Production incidence was not measured.
- **Legacy Curve valuation assumes comparable constituent values.** `src/clients/curve.ts:75` values the whole LP from virtual price and the first coin. Registration in a stableswap registry alone does not verify the assumption at the requested block. Assess supported pools and depeg periods against the newer reserve-based adapter before retaining this writer. This audit did not independently validate external pool contracts or historical market states.
- **Observation provenance is incomplete in stored history.** `scripts/lib/stored-historical-prices.ts:43` uses the stored EOD key as the path timestamp while explicitly labeling the original observation unknown. `src/registries/market-price.ts:47` similarly reports requested time for Chainlink leaves; raw source attempts retain additional evidence in graph artifacts. These are deliberate conventions, so a graph's timestamp validation should not be described as proving six-hour freshness for all reused legacy rows or Chainlink rounds.
- **Repair propagation depends on cache revision management.** Closed-day cache policy is currently 30 days at the edge and one hour in browsers (`src/cache/headers.ts:5`). `README.md:172` incorrectly says five minutes and browser revalidation, while the repair runbook describes the longer current policy. Correct the README and make cache invalidation part of any historical repair procedure. A worker revision does not invalidate already delivered browser responses.
- **Database performance needs measurements.** The API has bounded batch/range inputs and exact-read chunking. Potentially expensive offline reads include `lower(token)` preflight/coverage queries and repeated whole-history aggregation. No production row counts, query plans, database egress, or contention measurements were collected, so no index or latency claim is presented as a confirmed defect.
- **Protocol-specific pricing remains a separate assurance task.** Adapter formulas, allowlists, decimals handling, historical block use, and dependency guards were inspected, but feed addresses, proxy upgrades, economic redemption assumptions, and contract behavior were not independently checked against live chains.

## Maintainability and performance assessment

The largest maintainability problem is inconsistent enforcement of the same pricing contract across multiple paths. Source wrappers, warmup, chart backfill, graph backfill, and coverage research each decide differently what constitutes a valid observation, a missing result, or a retryable failure. A02, A03, A08, A11, and A12 are concrete consequences. A shared validated observation type should carry identity, requested and observed times, endpoint/source provenance, and a result category through those paths.

Request normalization has a similar split: API parsing, cache canonicalization, and response-key reconstruction each interpret token identity independently. A04 and A05 should be addressed with a single normalized request model rather than additional cache-specific parsing rules.

Run reporting also needs one authoritative outcome model. The graph runner already emits per-target outcomes, but the post-backfill report reconstructs state from older event types, causing A13. CLI exit status should derive from the same final outcomes, addressing A14 without duplicating success rules.

For performance, prioritize eliminating repeated constituent requests (A08) and bounding pending live requests (A07). Existing batch sizes are repository defaults, not asserted provider maxima. The graph scheduler's frontier batching and exact lookup reuse provide a useful implementation pattern. SQL indexing and broader concurrency changes should follow measurements rather than speculative tuning.

## Suggested remediation order

1. Establish finalization and write invariants: A01 and A02. Audit existing rows read-only before planning any data correction.
2. Close unsafe historical dependency paths: A03 and A10. Make coverage honor quarantine: A12.
3. Repair cache identity and failure caching: A04, A05, and A06; invalidate affected cache entries when deploying fixes.
4. Consolidate provider controls and deadlines: A07, A08, and A09. Preserve malformed-response semantics: A11.
5. Make run outcomes trustworthy: A13 and A14. Tighten timestamp validation: A15, and reconcile the cache documentation.

## Original audit coverage and verification

Inspected the worker entry point and landing page; authentication/error handling; all API routes; cache key and header policies; validation/time/address helpers; database read/write helpers and migrations; provider HTTP, Enso, RPC, Curve, and Chainlink code; source registries; DeFiLlama batching/matching/quarantine/LP guards; recursive and graph engines; adapter implementations; warmup; chart and graph finalization; day-alignment and checksum repair; coverage/inventory/reporting tools; workflow configuration; and relevant documentation and existing tests. Older replay orchestration and the complete test corpus received selective coverage rather than a line-by-line review.

Verification performed: static call-path tracing from inputs through cache, providers, persistence, and reporting; comparison with sibling implementations; inspection of existing tests and documented policies; repository status and revision checks; and source-line verification for findings. Relevant tests inspected include `test/edge-cache.test.ts`, `test/prices-spot.test.ts`, `test/insert-token-prices.test.ts`, `test/integration/current-day.integration.test.ts`, `test/scripts/offline-provider.test.ts`, `test/sources/defillama/lp-guard.test.ts`, and `test/backfill/matcher.test.ts`.

Tests and lint were not run, in accordance with the supplied Astra instruction. Typecheck, build, runtime reproductions, benchmarks, dependency vulnerability scanning, deployment checks, production database queries, and live provider/RPC calls were also not performed. No secrets were read or included. Suggested verification cases are follow-up work, not claims of passing tests.

Original audit deliverables: this Markdown report and the standalone local `AUDIT.html` review document. Application code and database state were unchanged during that audit; the remediation section records subsequent implementation.
