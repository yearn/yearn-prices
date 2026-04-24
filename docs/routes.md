# Route Usage

This service exposes a small JSON API for health checks and historical token prices.

## Base Behavior

- All documented routes support `GET`.
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

## Sources

Price routes accept an optional `source` query parameter. Supported values are:

- `defillama`
- `on-chain-oracle`
- `bobs-api`
- `derived`

When `source` is omitted, the API returns the first available row by priority:

1. `defillama`
2. `on-chain-oracle`
3. `bobs-api`
4. `derived`

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
- Requests involving today's UTC day: `public, max-age=3600, stale-while-revalidate=14400`
- Fully resolved batch or range for past days: `public, max-age=31536000, immutable`
- Partially resolved batch or range for past days: `public, max-age=3600`
- Historical not found responses: `public, max-age=3600, stale-while-revalidate=14400`
