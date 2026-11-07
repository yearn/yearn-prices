# Shared historical graph work

Each repair run owns a bounded session. It shares historical block facts, adapter instances and their read budgets, successful immutable dependency plans, exact successful market evidence, optional derivation results, and stored observations across graph windows. It does not cache selected derived paths or graph failures: each window rebuilds the dependency proof and reapplies cycle/depth/node-budget and finalization checks.

Block facts are keyed by chain, requested time or explicit block, and cancellation context. No token address or client is shared in those entries. Plans and market paths additionally include the token and explicit block. Latest/spot requests do not use these historical caches. The run must retain the same providers, adapter configuration and finalized-only policy throughout its lifetime.

Rejected promises are removed, including the adapter's per-target context promise. Successful market misses are not retained by the graph cache, so newly stored evidence can still be considered; the existing DeFiLlama batch cache retains run-local acquisition outcomes to prevent retry fanout. Source and queue cooldowns remain in force. Derivation results are keyed by the full supplied input evidence and retain their historical observation timestamps.

`--graph-batch-size` controls the root window, default 50 and maximum 100. Exact audit manifests are grouped by chain and day, newest first. The worker claims only that window and resolves all its dependency frontiers together. RPC concurrency remains 2 and provider RPS remains 1 by default. Larger root windows improve coalescing without opening more simultaneous requests. They can take longer to drain; the existing deadline reserve and observed-batch-duration check still bound new claims.

The `graph-cache` diagnostic records hit/miss/eviction counters and run-level adapter RPC reads. The existing batching counters record provider traffic. All cache maps are bounded to 32,000 entries; they disappear at the end of the run. Replay entry metrics include cumulative per-node read budgets; summary adapter RPC reads count only reads dispatched in that replay.

## Is a graph the best pricing model?

A dependency graph is appropriate, but the useful model is a set of alternative valuation recipes, not an indiscriminate walk through every token. A vault recipe needs an asset price AND its historical share conversion. An LP recipe needs its constituent values AND historical reserves/supply. A token can have an oracle route OR a wrapper route OR an eligible market route. The selected proof must end at independently supported prices; circular exchange ratios cannot establish a USD price by themselves.

For example, a historical vault share redeeming 1.08 units of an asset priced at $3,000 has a $3,240 derived value, provided both observations satisfy the historical checks. The graph can recover that share value even when no provider has a direct vault quote. It cannot recover a trustworthy USD value if every reachable leaf is unpriced.

The next coverage improvement should be evidence-ranked, demand-driven route discovery: recognize known token types cheaply, try credible direct anchors and deterministic conversions first, and expand additional expensive adapters when the selected route lacks valid inputs. Rank by observation quality and historical validity before estimated request cost. Preserve alternatives so a missing constituent does not prematurely stop the search. Add verified adapter/feed coverage for unpriced leaves; a larger cache alone cannot invent a missing anchor.

For DEX-derived anchors, a historically valid TWAP and liquidity checks are preferable to accepting any instantaneous reserve ratio. This is a proposed coverage strategy, not a new valuation rule in this PR. No assumption that a wrapped or pegged asset always equals its reference asset is introduced.

Primary references:

- [ypricemagic](https://github.com/BobTheBuidler/ypricemagic) exposes per-token and batched historical block pricing and protocol-specific implementations; archive data remains necessary.
- [Chainlink historical data](https://docs.chain.link/data-feeds/price-feeds/historical-data) explains rounds, observation times and aggregator phases that historical anchors must respect.
- [Uniswap v2 whitepaper](https://docs.uniswap.org/whitepaper.pdf) describes time-weighted prices and the manipulation/freshness tradeoff.
