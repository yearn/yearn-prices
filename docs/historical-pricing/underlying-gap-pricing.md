# Historical underlying gaps and LP pricing

This change investigates the 34 underlyings / 179 underlying-day gaps in audit
[42410917285](https://github.com/yearn/yearn-prices/actions/runs/42410917285),
October 31–November 6, 2026. The frozen audit also contains 179 dependent
vault-day gaps. A replay candidate is not a persisted price: historical graph
validation, finalization and a database readback are separate steps.

## Pricing changes

- pxETH can use the reviewed pxETH/stETH Curve pool
  `0x6951bDC4734b9f7F3E1B74afeBC670c736A0EDB6`. Historical coin membership,
  EMA, stored rates, decimals and the existing $20,000 quote-liquidity floor
  are checked. No ETH peg is assumed. The pool is listed by the
  [Curve pool API](https://api.curve.fi/api/getPools/all/ethereum).
- Stable Velodrome V2 / Aerodrome LPs can derive one genuinely missing
  constituent from the pool's historical `getAmountOut` quote. Both missing
  constituents still require an independent priced anchor. Factory registration,
  actual token holdings, a $20,000 independently priced reserve and the
  full-reserve payout are required. Transport failures never become missing
  inputs. These are pool-implied valuations, not independent token oracle prices.
- The stable invariant is `x³y + xy³`. Its extreme-skew full-reserve payout is
  7/24 of its marginal mark; the 25% executable-share floor allows fees and
  rounding. Derived reserve value is also bounded by four times the anchor
  value. This differs from constant-product math and does not assume a peg.
  See [Velodrome contracts](https://github.com/velodrome-finance/contracts) and
  [Aerodrome Pool.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol).
- Curve zero supply, zero reserves, unbacked reserves and failed swap-depth
  checks have specific refusal reasons. These checks are retained, not bypassed.

## Evidence and CI

Graph backfills now write `<report>.gaps.json` with one outcome for every pending
target: a historically validated candidate or the concrete failing dependency
and available refusal reason. Candidates remain distinct from finalization
outcomes. The weekly audit uploads only these curated reports alongside its
existing summaries; full graphs and arbitrary provider/RPC exceptions remain
private. No new deployment or credentials are required.

A private replay can also be summarized without network or database access:

```sh
bun scripts/explain-price-gaps.ts --manifest targets.json \
  --graph replay.jsonl.graph.json --out gaps.json
```

The report validates root count, chain, token and day against the manifest.
Only constrained application-authored error messages are copied; unknown errors
retain their failure category without exposing connection strings or payloads.
