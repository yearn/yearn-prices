import { CHAIN_ID_TO_NAME } from './utils/chains'
import type { Env } from './types'

function supportedChains(env: Env): Array<{ id: number, name: string }> {
  return Object.keys(env)
    .filter(key => key.startsWith('RPC_URL_'))
    .map(key => Number(key.slice('RPC_URL_'.length)))
    .filter(id => Number.isFinite(id))
    .sort((left, right) => left - right)
    .map(id => ({ id, name: CHAIN_ID_TO_NAME[id as keyof typeof CHAIN_ID_TO_NAME] ?? String(id) }))
}

export function renderLandingPage(env: Env, baseUrl: string): string {
  const chains = supportedChains(env)
  const chainList = chains.length > 0
    ? `<ul class="chains">${chains.map(chain => `<li><span class="chain-name">${chain.name}</span><span class="chain-id">${chain.id}</span></li>`).join('')}</ul>`
    : '<p class="muted">No chains are configured on this deployment.</p>'

  const curl = `curl \\
  -H "Authorization: Bearer $API_KEY" \\
  --get "${baseUrl}/api/prices/spot" \\
  --data-urlencode 'coins=["ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"]'`

  const sampleResponse = `{
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
}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yearn Price Service</title>
<style>
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: #09090b;
    color: #f4f4f5;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 1rem;
    line-height: 1.6;
  }
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 4rem 1.5rem;
  }
  h1 {
    font-size: 1.875rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 0.75rem;
  }
  h2 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 1rem;
  }
  section { margin-top: 3rem; }
  p { margin: 0 0 1rem; }
  .lede { color: #a1a1aa; margin-bottom: 0; }
  .muted { color: #a1a1aa; }
  a { color: #f4f4f5; }
  a:hover { color: #a1a1aa; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 0.875rem;
  }
  pre {
    background: #18181b;
    border-radius: 0.5rem;
    padding: 1rem;
    margin: 0;
    overflow-x: auto;
    color: #e4e4e7;
  }
  .endpoints { display: flex; flex-direction: column; gap: 0.75rem; }
  .endpoint {
    background: #18181b;
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .endpoint .path {
    color: #f4f4f5;
    word-break: break-all;
  }
  .endpoint .method { color: #a1a1aa; margin-right: 0.5rem; }
  .endpoint .note {
    color: #a1a1aa;
    font-size: 0.875rem;
    margin: 0.25rem 0 0;
  }
  .chains {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.5rem;
  }
  .chains li {
    background: #18181b;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .chain-id {
    color: #a1a1aa;
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 0.875rem;
  }
  ul.bullets { margin: 0; padding-left: 1.25rem; color: #a1a1aa; }
  ul.bullets li { margin-bottom: 0.375rem; }
  .code-block { position: relative; }
  .copy {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: #27272a;
    color: #e4e4e7;
    border: 0;
    border-radius: 0.375rem;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
  }
  .copy:hover { background: #3f3f46; }
  footer {
    margin-top: 4rem;
    padding-top: 1.5rem;
    border-top: 1px solid #27272a;
    color: #a1a1aa;
    font-size: 0.875rem;
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Yearn Price Service</h1>
    <p class="lede">Spot and historical token prices for Yearn, aggregated from DefiLlama, on-chain oracles, Curve, Bob's API, and Enso.</p>
  </header>

  <section>
    <h2>Endpoints</h2>
    <div class="endpoints">
      <div class="endpoint">
        <div class="path"><span class="method">GET</span><code>/api/health</code></div>
        <p class="note">Service health. Unauthenticated. Returns <code>{ status, timestamp }</code>.</p>
      </div>
      <div class="endpoint">
        <div class="path"><span class="method">GET</span><code>/api/prices/spot?coins=["chain:0xaddress",...]</code></div>
        <p class="note">Live spot prices for up to 50 token keys, proxied from Enso.</p>
      </div>
      <div class="endpoint">
        <div class="path"><span class="method">GET</span><code>/api/prices/historical/:timestamp/:tokenKey</code></div>
        <p class="note">One exact historical price for one token and one normalized UTC day.</p>
      </div>
      <div class="endpoint">
        <div class="path"><span class="method">GET</span><code>/api/prices/batchHistorical?coins={"chain:0xaddress":[timestamp,...]}</code></div>
        <p class="note">Historical prices for many token and timestamp pairs.</p>
      </div>
      <div class="endpoint">
        <div class="path"><span class="method">GET</span><code>/api/prices/rangeHistorical?coins={"chain:0xaddress":[start,end]}</code></div>
        <p class="note">Historical prices for one or more token ranges.</p>
      </div>
    </div>
    <p class="note muted">Token keys use the format <code>chain:0xaddress</code>, for example <code>ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48</code>.</p>
  </section>

  <section>
    <h2>Authentication</h2>
    <p class="muted">All <code>/api/prices/*</code> routes require an API key, supplied by either <code>Authorization: Bearer &lt;key&gt;</code> or <code>x-api-key: &lt;key&gt;</code>. Keys are provisioned per consumer.</p>
  </section>

  <section>
    <h2>Supported Chains</h2>
    ${chainList}
  </section>

  <section>
    <h2>Example request</h2>
    <div class="code-block">
      <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('curl-command').textContent)">Copy</button>
      <pre id="curl-command">${curl}</pre>
    </div>
  </section>

  <section>
    <h2>Example response</h2>
    <pre>${sampleResponse}</pre>
  </section>

  <section>
    <h2>Caching</h2>
    <ul class="bullets">
      <li>Spot: <code>public, s-maxage=120, stale-while-revalidate=600</code>.</li>
      <li>Historical prices for past days: <code>public, max-age=31536000, immutable</code>.</li>
      <li>Historical requests for today's UTC day: <code>public, s-maxage=300, max-age=3600, stale-while-revalidate=14400</code>.</li>
      <li>Partially resolved batch or range for past days: <code>public, max-age=3600</code>.</li>
      <li>Responses are edge-cached at Cloudflare with canonicalized URLs, so requests that differ only in query order, whitespace, or address casing share one entry.</li>
    </ul>
  </section>

  <footer>
    <a href="https://github.com/yearn/yearn-prices">github.com/yearn/yearn-prices</a>
  </footer>
</main>
</body>
</html>`
}
