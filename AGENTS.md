# Provider usage in offline jobs and diagnostics

- Use DeFiLlama's batched endpoints for multi-target workloads, including
  temporary replay/benchmark scripts. Prefer `/batchHistorical` for multiple
  tokens and dates, or `/prices/historical/{timestamp}/{coins}` for tokens at
  one timestamp. Do not loop over single-token HTTP requests for a known set.
- Reuse `src/sources/defillama/batch.ts` to split and deduplicate requests and
  `src/sources/defillama/match.ts` to match returned observations. Current batch
  sizes are conservative repository defaults, not documented provider maxima.
- Prefetch known root and child targets, share an exact token/timestamp cache
  across the run, and coalesce newly discovered dependencies into batches.
  Preserve observation timestamps and record which endpoint produced them.
- Batching reduces HTTP traffic; it does not guarantee exemption from quotas.
  Bound batch concurrency and honor the provider's full `Retry-After` through a
  shared cooldown. Do not fan out single-request retries after a failed batch.
- Keep successful empty responses separate from malformed responses, 429s,
  timeouts, and 5xx failures. Only successful, well-formed responses establish
  missing observations. Failed requests remain retryable, never zero-valued.

# Review output

Provide a working private preview or HTML review document when presenting
changes. Use the `tailscale-preview` skill for a Tailscale link. Keep private
Tailscale URLs out of GitHub comments and pull request descriptions.
