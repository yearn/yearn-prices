# Spot coverage benchmark

`benchmark:spot` compares the previous Enso + derived source chain with the new
Enso + DeFiLlama + derived chain while keeping the target set and source-level
requests stable.

Run it against the active Yearn vault inventory:

```sh
ENSO_API_KEY=... bun run benchmark:spot -- --out /tmp/spot-coverage.json --html /tmp/spot-coverage.html
```

For a repeatable target set or a saved inventory, pass a JSON file containing an
array of `{ "chain": "ethereum", "token": "0x...", "label": "..." }`
objects, or `{ "targets": [...] }`:

```sh
bun run benchmark:spot -- --targets ./targets.json --out ./spot-coverage.json
```

The target file controls only the addresses; the benchmark still makes live
Enso, DeFiLlama and RPC calls. It is therefore a reproducible target set, not
an offline fixture. A run without provider credentials is not a coverage claim.

The JSON report is sorted by chain and token. Each comparison records whether
the baseline or candidate was priced, whether the quote was direct or derived,
the provider observation timestamp, latency, and any error. Candidate recovery
is split into targets recovered from a baseline miss and targets recovered from
a baseline error. When both runs return a price, the report records source
changes and price disagreement at the configured threshold (100 bps by
default; override with `--disagreement-bps`).

The benchmark shares exact source calls between the two runs, including
failures, so the fallback comparison does not double-request Enso or
DeFiLlama. Root targets are prefetched through DeFiLlama's batched current
endpoint. Each comparison gets a fresh derived resolver budget; child market
lookups use the shared exact cache. RPC observations are live and may drift
between runs, so the report is directional rather than historical or
block-pinned. Latency is measured at the resolver boundary and includes cache
hits; it is not an HTTP request-count metric.

Use the generated HTML for a private review of a run; it embeds the same
machine-readable report and does not publish any data.
