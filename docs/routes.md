# Route Usage

This service exposes a small JSON API for health checks and historical token prices.

## Base Behavior

- Read routes support `GET`; the scoped daily enqueue route uses `POST`.
- `OPTIONS` requests return `204` with CORS headers.
- All JSON responses include permissive CORS headers.
- `/api/health` is public.
- Price routes require an API key, supplied by either:
  - `Authorization: Bearer <api-key>`
  - `x-api-key: <api-key>`

The worker accepts API keys from environment variables named `API_KEY_*`. The matched suffix is logged as the client id.

## Token Keys

Price routes identify assets with a token key:

```text
<chain>:<token-address>
```

Example:

```text
ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
```

Supported chain names:

- `ethereum`
- `optimism`
- `gnosis`
- `polygon`
- `sonic`
- `fantom`
- `base`
- `arbitrum`
- `berachain`
- `katana`

Token addresses must be EVM `0x` addresses with 40 hex characters. Chain names and token addresses are normalized to lowercase.

## Timestamps

Historical price timestamps are Unix timestamps in seconds. The API normalizes every timestamp to the end of its UTC day:

```text
floor(timestamp / 86400) * 86400 + 86399
```

For example, any timestamp on `2024-01-01` UTC is queried as `2024-01-01T23:59:59.000Z`.

The strict `/api/daily-prices/*` routes require the path timestamp itself to equal `23:59:59 UTC`. Unlike the
legacy historical routes, they reject intraday path timestamps instead of normalizing them.

## Sources

Price routes accept an optional `source` query parameter. Supported values are:

- `defillama`
- `defillama-canonical-market-proxy`
- `defillama-coingecko-alias`
- `on-chain-oracle`
- `bobs-api`
- `curve`
- `derived`
- `enso`
- `binance`
- `stable-peg` (legacy inspection only; never strict EOD evidence)

When `source` is omitted, the API returns the first available row by priority:

1. `defillama`
2. `defillama-canonical-market-proxy`
3. `defillama-coingecko-alias`
4. `on-chain-oracle`
5. `bobs-api`
6. `curve`
7. `derived`
8. `enso`
9. `binance`
10. `stable-peg`

## `GET /api/health`

Returns service health. This route does not require authentication.

Example:

```bash
curl http://localhost:8787/api/health
```

Response:

```json
{
  "status": "ok",
  "timestamp": 1719878400
}
```

## `POST /api/daily-prices/enqueue`

Authenticates and idempotently registers the assets needed for one closed UTC day. Existing accepted EOD evidence is
returned immediately; missing asset-days are inserted into the durable worker queue. The request never resolves a
price inline.

Limits:

- one closed day per request;
- maximum 500 target assets;
- maximum 128 KiB request body;
- deduplicated by normalized chain, token, and EOD timestamp.

```json
{
  "day": "2024-01-01",
  "targets": [
    {
      "chain": "ethereum",
      "token": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    }
  ]
}
```

The `day` field may be omitted to select the latest closed UTC day.

## `POST /api/daily-prices/requeue`

Reactivates reviewed `unsupported` or `quarantined` targets. Authentication is required. The request must include a
reason and exactly one bounded scope:

- `targets`: up to 500 exact chain, token, and closed-day entries; or
- `filter`: one chain and closed day, optionally narrowed by terminal status, failure class, adapter, adapter version,
  or policy version.

```json
{
  "reason": "amm-nav-v2 now prices every reviewed constituent",
  "filter": {
    "chain": "optimism",
    "day": "2024-01-01",
    "statuses": ["quarantined"],
    "adapterVersion": "amm-nav-v2"
  }
}
```

Before resetting attempt and lease state, the service writes an audit containing the authenticated client id, reason,
normalized scope, and complete prior target outcomes. The `202 Accepted` response includes the audit id and exact
targets requeued. Requeueing never resolves prices inside the request.

## `GET /api/daily-prices/:timestamp/:tokenKey`

Returns only an accepted exact-EOD price. The timestamp must itself be `23:59:59 UTC`; an intraday stored row cannot
satisfy the request. Missing evidence returns `404`, and disagreement quarantine returns `409`.

The response adds `adapter`, `classification`, and `quality` without changing the legacy historical response.

## `GET /api/daily-prices/evidence/:timestamp/:tokenKey`

Returns the deterministic selection, every persisted candidate for the exact EOD key, and its validation result. It
never performs repair and uses `no-store` caching so operators see current policy state.

## `GET /api/daily-prices/progress`

Returns authenticated live queue state: chain distribution, current leases, total/attempted/remaining counts, durable
outcomes, source/adapter/quality counts, elapsed time, rolling processing rate, ETA, and recent sanitized failure
reasons. The matching dashboard is available at `/daily-prices`.

## `GET /api/prices/historical/:timestamp/:tokenKey`

Returns one exact historical price for one token and one normalized UTC day.

Path parameters:

- `timestamp`: Unix timestamp in seconds.
- `tokenKey`: `<chain>:<token-address>`.

Query parameters:

- `source`: optional price source filter.

Example:

```bash
curl \
  -H "Authorization: Bearer $API_KEY" \
  "http://localhost:8787/api/prices/historical/1704153599/ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
```

Response:

```json
{
  "coins": {
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      "price": 1.0001,
      "symbol": "USDC",
      "timestamp": 1704153599,
      "confidence": 0.99,
      "source": "defillama"
    }
  }
}
```

If no exact row exists for the normalized timestamp, the route returns:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "No historical price found for ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 at 1704153599"
  }
}
```

## `GET /api/prices/spot`

Proxies the latest spot price for one or more tokens from [Enso](https://docs.enso.build/api-reference/tokens/token-price). The request and response shapes mirror `batchHistorical`.

This is a stateless proxy: it validates, fetches from Enso, and returns. It does **not** write to `token_prices`. Spot is a latest-price use case served by the edge cache; persisting a mid-day spot price as that day's historical close would pollute the price history (see the [Cache-Control](#cache-control) section for the edge TTL).

Each returned `timestamp` is the price's own time in Unix seconds — Enso reports a millisecond timestamp, which is converted to seconds (or the current time is used when Enso omits it). Unlike the historical routes, spot timestamps are not normalized to a UTC day-end.

Requires the `ENSO_API_KEY` worker secret (`wrangler secret put ENSO_API_KEY`).

Query parameters:

- `coins`: required JSON array of token keys.

The `coins` array lists token keys (`<chain>:<token-address>`):

```json
["ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"]
```

Limits:

- Maximum `50` token keys.
- Duplicate token keys are deduplicated after normalization.

Example:

```bash
curl \
  -H "Authorization: Bearer $API_KEY" \
  --get "http://localhost:8787/api/prices/spot" \
  --data-urlencode 'coins=["ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"]'
```

Response:

```json
{
  "coins": {
    "ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": {
      "symbol": "WBTC",
      "prices": [
        {
          "timestamp": 1719878399,
          "price": 27052,
          "confidence": 0.99,
          "source": "enso"
        }
      ]
    }
  }
}
```

Each token's single `prices` entry carries the spot price's own Unix-seconds timestamp. Tokens Enso has no price for are omitted from the response, like `batchHistorical`.

## `GET /api/prices/batchHistorical`

Returns exact historical prices for multiple token and timestamp pairs.

Query parameters:

- `coins`: required JSON object encoded into the query string.
- `source`: optional price source filter.

The `coins` object maps token keys to arrays of Unix timestamps:

```json
{
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": [1704153599, 1704239999],
  "base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": [1704153599]
}
```

Limits:

- Maximum `50` token keys.
- Maximum `90` timestamps per token.
- Duplicate timestamps for the same token are deduplicated after day-end normalization.

Example:

```bash
curl \
  -H "x-api-key: $API_KEY" \
  --get "http://localhost:8787/api/prices/batchHistorical" \
  --data-urlencode 'coins={"ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48":[1704153599,1704239999]}'
```

Response:

```json
{
  "coins": {
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      "symbol": "USDC",
      "prices": [
        {
          "timestamp": 1704153599,
          "price": 1.0001,
          "confidence": 0.99,
          "source": "defillama"
        },
        {
          "timestamp": 1704239999,
          "price": 1.0002,
          "confidence": 0.99,
          "source": "defillama"
        }
      ]
    }
  }
}
```

Only found prices are returned. Missing token and timestamp pairs are omitted from the response.

## `GET /api/prices/rangeHistorical`

Returns historical prices for one or more token ranges.

Query parameters:

- `coins`: required JSON object encoded into the query string.
- `source`: optional price source filter.

The `coins` object maps token keys to `[start, end]` Unix timestamp ranges:

```json
{
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": [1704067200, 1704239999]
}
```

Both `start` and `end` are normalized to UTC day-end timestamps. The route returns rows whose stored timestamp is between the normalized start and end, inclusive.

Limits:

- Maximum `50` token keys.
- Maximum `366` normalized UTC days per token range.
- Range start must be less than or equal to range end after normalization.

Example:

```bash
curl \
  -H "Authorization: Bearer $API_KEY" \
  --get "http://localhost:8787/api/prices/rangeHistorical" \
  --data-urlencode 'coins={"ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48":[1704067200,1704239999]}'
```

Response:

```json
{
  "coins": {
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      "symbol": "USDC",
      "prices": [
        {
          "timestamp": 1704153599,
          "price": 1.0001,
          "confidence": 0.99,
          "source": "defillama"
        },
        {
          "timestamp": 1704239999,
          "price": 1.0002,
          "confidence": 0.99,
          "source": "defillama"
        }
      ]
    }
  }
}
```

Only found prices are returned. Missing days are omitted from the response.

## Errors

Errors use this JSON shape:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid coins query parameter"
  }
}
```

Known error codes:

- `INVALID_INPUT`: `400`
- `UNAUTHORIZED`: `401`
- `NOT_FOUND`: `404`
- `RATE_LIMITED`: `429`
- `INTERNAL_ERROR`: `500`

Common error cases:

- Missing API key: `UNAUTHORIZED`.
- Invalid API key: `UNAUTHORIZED`.
- Missing `coins` query parameter: `INVALID_INPUT`.
- Invalid `coins` JSON: `INVALID_INPUT`.
- Unsupported `source`: `INVALID_INPUT`.
- Unknown route: `NOT_FOUND`.

## Cache-Control

Price responses set cache headers based on the requested timestamps and whether every requested value was found.

- Historical non-today exact price: `public, max-age=31536000, immutable`
- Requests involving today's UTC day: `public, s-maxage=300, max-age=3600, stale-while-revalidate=14400`
- Fully resolved batch or range for past days: `public, max-age=31536000, immutable`
- Partially resolved batch or range for past days: `public, max-age=3600`
- Historical not found responses: `public, max-age=3600, stale-while-revalidate=14400`
- Spot: `public, s-maxage=120, stale-while-revalidate=600`

## Edge caching

Worker-generated responses do not populate Cloudflare's edge cache from a `Cache-Control` header alone — that header only drives the client/browser cache. Successful `GET` responses for all price routes are therefore stored in the edge cache (`caches.default`) explicitly and served from it on subsequent requests, using the TTLs above. A request is served from the edge before any Enso fetch or database query runs.

Spot has no upstream cache policy (Enso sends only a weak `etag`), so its `s-maxage=120` is a chosen shared-cache TTL — short enough to keep prices fresh, long enough to absorb bursts — mirroring the Enso proxy already shipping in yearn.fi.

The store/TTL decision is delegated to the Cache API: `caches.default.put()` reads the response's `Cache-Control`, refusing `no-store`/`private` and deriving the edge TTL from `s-maxage` (falling back to `max-age`, then `Expires`). Only successful responses are offered to `put()` — errors return straight from the worker's catch block and are never edge-stored (generic errors additionally carry `no-store` for downstream caches; historical not-found is the deliberate exception, returning a browser-cacheable negative result). Today's data sets `s-maxage=300` so the shared edge refreshes every ~5min, tracking the hourly warmup far more closely than the 1h browser `max-age`. The cache key is the request URL canonicalized first (sorted query params, and `coins` re-serialized with sorted keys and lowercased addresses) so requests that differ only in JSON ordering, whitespace, or address casing share one entry. Positional arrays — a range's `[start, end]` and a batch token's timestamp list — are never reordered, so two requests that differ in those never collide.
