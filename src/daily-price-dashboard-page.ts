const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="description" content="Live operator view of the Yearn Prices historical daily price queue.">
    <title>Daily prices | Yearn Prices</title>
    <link rel="stylesheet" href="/daily-prices/styles.css">
    <script src="/daily-prices/app.js" defer></script>
  </head>
  <body>
    <header class="masthead">
      <div>
        <p class="eyebrow">Yearn Prices / Operator</p>
        <h1>Daily prices</h1>
      </div>
      <div class="masthead-status" aria-live="polite">
        <span id="run-state" class="status status-neutral">Not connected</span>
        <span id="sync-time" class="meta">Waiting for credentials</span>
      </div>
    </header>

    <section id="auth-panel" class="auth-panel" aria-labelledby="auth-heading">
      <div>
        <h2 id="auth-heading">Connect to the local run</h2>
        <p>Use any API key configured for this Worker. It is retained only for this browser tab.</p>
      </div>
      <form id="key-form" class="key-form">
        <label for="api-key">API key</label>
        <div class="key-entry">
          <input id="api-key" name="api-key" type="password" autocomplete="current-password" required>
          <button type="submit">Connect</button>
        </div>
        <p id="auth-error" class="form-message" role="alert"></p>
      </form>
    </section>

    <main id="dashboard" hidden>
      <div class="toolbar">
        <p id="activity-note" class="meta">Run state is inferred from durable queue activity.</p>
        <div class="toolbar-actions">
          <button id="refresh-button" class="text-button" type="button">Refresh</button>
          <button id="pause-button" class="text-button" type="button" aria-pressed="false">Pause polling</button>
          <button id="forget-button" class="text-button" type="button">Forget key</button>
        </div>
      </div>

      <p id="dashboard-error" class="notice" role="alert" hidden></p>

      <section class="progress-section" aria-labelledby="progress-heading">
        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">Terminal outcomes / all targets</p>
            <h2 id="progress-heading">Overall progress</h2>
          </div>
          <p id="progress-value" class="progress-value">0.00%</p>
        </div>
        <div id="progress-track" class="progress-track" role="progressbar" aria-label="Resolved daily price targets" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div id="progress-fill" class="progress-fill"></div>
        </div>
        <dl class="summary-ledger">
          <div><dt>Resolved</dt><dd id="resolved-value">0</dd></div>
          <div><dt>Remaining</dt><dd id="remaining-value">0</dd></div>
          <div><dt>5 min rate</dt><dd id="rate-value">0 / min</dd></div>
          <div><dt>Estimated finish</dt><dd id="eta-value">Unavailable</dd></div>
        </dl>
        <p class="definition">Resolved includes prices written, unsupported targets, and quarantined targets. Retryable failures remain open.</p>
      </section>

      <section aria-labelledby="queue-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Durable states</p>
            <h2 id="queue-heading">Queue overview</h2>
          </div>
          <p id="queue-total" class="section-total">0 targets</p>
        </div>
        <dl class="state-ledger">
          <div><dt>Prices written</dt><dd id="priced-value">0</dd></div>
          <div><dt>Pending</dt><dd id="pending-value">0</dd></div>
          <div><dt>In progress</dt><dd id="in-progress-value">0</dd></div>
          <div><dt>Unsupported</dt><dd id="unsupported-value">0</dd></div>
          <div><dt>Retryable</dt><dd id="retryable-value">0</dd></div>
          <div><dt>Quarantined</dt><dd id="quarantined-value">0</dd></div>
          <div><dt>Active leases</dt><dd id="active-leases-value">0</dd></div>
          <div><dt>Expired leases</dt><dd id="expired-leases-value">0</dd></div>
        </dl>
      </section>

      <section aria-labelledby="chains-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Distribution</p><h2 id="chains-heading">Chains</h2></div>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Chain</th><th>Total</th><th>Resolved</th><th>Remaining</th><th>Written</th><th>Unsupported</th><th>Retryable</th></tr></thead>
            <tbody id="chains-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="adapters-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Successful resolution</p><h2 id="adapters-heading">Price adapters</h2></div>
        </div>
        <div class="table-scroll narrow-table">
          <table>
            <thead><tr><th>Adapter</th><th>Prices written</th><th>Share</th></tr></thead>
            <tbody id="adapters-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="sources-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Evidence provenance</p><h2 id="sources-heading">Sources</h2></div>
        </div>
        <div class="table-scroll narrow-table">
          <table>
            <thead><tr><th>Source</th><th>Prices written</th><th>Share</th></tr></thead>
            <tbody id="sources-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="qualities-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Accepted evidence</p><h2 id="qualities-heading">Quality</h2></div>
        </div>
        <div class="table-scroll narrow-table">
          <table>
            <thead><tr><th>Quality</th><th>Prices written</th><th>Share</th></tr></thead>
            <tbody id="qualities-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="active-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Unexpired leases</p><h2 id="active-heading">Current batch</h2></div>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Chain</th><th>Token</th><th>Requested price</th><th>Attempted</th><th>Lease expires</th></tr></thead>
            <tbody id="active-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="failures-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Sanitized categories</p><h2 id="failures-heading">Failures requiring context</h2></div>
        </div>
        <div class="table-scroll narrow-table">
          <table>
            <thead><tr><th>Outcome</th><th>Class</th><th>Resolution</th><th>Count</th></tr></thead>
            <tbody id="failures-body"></tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="recent-heading">
        <div class="section-heading">
          <div><p class="eyebrow">Latest durable updates</p><h2 id="recent-heading">Recent outcomes</h2></div>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Updated</th><th>Outcome</th><th>Chain</th><th>Token</th><th>Requested price</th><th>Adapter / reason</th></tr></thead>
            <tbody id="recent-body"></tbody>
          </table>
        </div>
      </section>
    </main>

    <footer>
      <p>Live data from <code>/api/daily-prices/progress</code>. Raw provider errors are intentionally omitted.</p>
    </footer>
  </body>
</html>`

const DASHBOARD_CSS = `:root {
  color-scheme: light dark;
  --paper: oklch(98.5% 0.006 78);
  --paper-muted: oklch(96.2% 0.007 78);
  --ink: oklch(21% 0.012 72);
  --ink-muted: oklch(48% 0.012 72);
  --ink-faint: oklch(62% 0.01 72);
  --rule: oklch(78% 0.009 72);
  --rule-subtle: oklch(89% 0.007 72);
  --focus: oklch(45% 0.08 245);
  --success-bg: oklch(92% 0.045 155);
  --success-ink: oklch(38% 0.09 155);
  --active-bg: oklch(93% 0.05 88);
  --active-ink: oklch(42% 0.095 75);
  --danger-bg: oklch(93% 0.035 28);
  --danger-ink: oklch(43% 0.09 28);
  --neutral-bg: oklch(93% 0.008 72);
  --neutral-ink: oklch(42% 0.012 72);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 16px;
  background: var(--paper);
  color: var(--ink);
}

* { box-sizing: border-box; }
html { overflow-y: scroll; background: var(--paper); }
body { margin: 0 auto; max-width: 1080px; min-height: 100vh; padding: 40px 32px 24px; background: var(--paper); }
button, input { font: inherit; }
button { min-height: 44px; }
[hidden] { display: none !important; }

.masthead { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--ink); }
.masthead h1 { margin: 4px 0 0; font-size: 1.35rem; line-height: 1.2; font-weight: 650; letter-spacing: -0.015em; }
.eyebrow { margin: 0; color: var(--ink-muted); font-size: 0.68rem; line-height: 1.3; letter-spacing: 0.09em; text-transform: uppercase; }
.masthead-status { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-height: 28px; }
.meta { margin: 0; color: var(--ink-muted); font-size: 0.75rem; line-height: 1.45; }

.status { display: inline-flex; align-items: center; justify-content: center; min-width: 92px; min-height: 24px; padding: 3px 9px; border-radius: 999px; font-size: 0.7rem; font-weight: 650; white-space: nowrap; }
.status-success { background: var(--success-bg); color: var(--success-ink); }
.status-active, .status-warning { background: var(--active-bg); color: var(--active-ink); }
.status-danger { background: var(--danger-bg); color: var(--danger-ink); }
.status-neutral { background: var(--neutral-bg); color: var(--neutral-ink); }

.auth-panel { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); gap: 48px; align-items: start; padding: 48px 0; border-bottom: 1px solid var(--rule); }
.auth-panel h2, .section-heading h2 { margin: 5px 0 0; font-size: 1.12rem; line-height: 1.25; font-weight: 650; letter-spacing: -0.01em; }
.auth-panel p { max-width: 62ch; margin: 10px 0 0; color: var(--ink-muted); font-size: 0.8rem; line-height: 1.55; }
.key-form label { display: block; margin-bottom: 7px; color: var(--ink-muted); font-size: 0.72rem; font-weight: 600; }
.key-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
.key-entry input { width: 100%; min-height: 44px; padding: 9px 11px; border: 1px solid var(--rule); border-right: 0; border-radius: 4px 0 0 4px; background: var(--paper); color: var(--ink); outline: none; }
.key-entry button { padding: 8px 16px; border: 1px solid var(--ink); border-radius: 0 4px 4px 0; background: var(--ink); color: var(--paper); font-weight: 650; cursor: pointer; }
.key-entry input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.key-entry button:hover { opacity: 0.86; }
.form-message { min-height: 20px; color: var(--danger-ink) !important; }

main { min-height: 720px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: 1px solid var(--rule-subtle); }
.toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 14px; }
.text-button { min-height: 36px; padding: 4px 0; border: 0; border-radius: 0; background: transparent; color: var(--ink-muted); font-size: 0.74rem; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 4px; cursor: pointer; }
.text-button:hover { color: var(--ink); text-decoration-color: currentColor; }
.text-button:disabled { color: var(--ink-faint); cursor: wait; }
.notice { margin: 20px 0 0; padding: 10px 12px; border: 1px solid var(--danger-ink); border-radius: 4px; background: var(--danger-bg); color: var(--danger-ink); font-size: 0.78rem; line-height: 1.45; }

section { padding: 44px 0 8px; }
.progress-section { padding-top: 48px; }
.section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 16px; }
.compact-heading { margin-bottom: 14px; }
.section-total, .progress-value { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.section-total { color: var(--ink-muted); font-size: 0.74rem; }
.progress-value { font-size: 1rem; font-weight: 650; }
.progress-track { height: 8px; overflow: hidden; border-radius: 2px; background: var(--rule-subtle); }
.progress-fill { width: 0; height: 100%; background: var(--ink); transform-origin: left center; transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1); }
.summary-ledger { display: grid; grid-template-columns: repeat(4, 1fr); margin: 26px 0 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.summary-ledger div { padding: 14px 16px 15px 0; }
.summary-ledger div + div { padding-left: 16px; border-left: 1px solid var(--rule-subtle); }
dt { color: var(--ink-muted); font-size: 0.68rem; line-height: 1.35; }
dd { margin: 7px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86rem; font-variant-numeric: tabular-nums; }
.definition { max-width: 72ch; margin: 12px 0 0; color: var(--ink-muted); font-size: 0.72rem; line-height: 1.55; }
.state-ledger { display: grid; grid-template-columns: repeat(4, 1fr); margin: 0; border-top: 1px solid var(--rule); }
.state-ledger div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; padding: 11px 16px 11px 0; border-bottom: 1px solid var(--rule-subtle); }
.state-ledger div:nth-child(4n + 2), .state-ledger div:nth-child(4n + 3), .state-ledger div:nth-child(4n + 4) { padding-left: 16px; }

.table-scroll { overflow-x: auto; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.narrow-table { max-width: 760px; }
table { width: 100%; min-width: 780px; border-collapse: collapse; font-size: 0.73rem; }
.narrow-table table { min-width: 560px; }
th { padding: 9px 12px 8px 0; color: var(--ink-muted); font-size: 0.62rem; font-weight: 650; letter-spacing: 0.07em; text-align: left; text-transform: uppercase; white-space: nowrap; }
td { padding: 10px 12px 10px 0; border-top: 1px solid var(--rule-subtle); vertical-align: middle; }
tbody tr:hover { background: color-mix(in oklch, var(--ink) 3%, transparent); }
th:not(:first-child), td:not(:first-child) { padding-left: 12px; }
td.numeric { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; text-align: right; }
th.numeric { text-align: right; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-muted); }
.empty-row td { height: 58px; color: var(--ink-muted); text-align: center; }

footer { margin-top: 48px; padding: 18px 0 4px; border-top: 1px solid var(--ink); color: var(--ink-muted); font-size: 0.7rem; line-height: 1.5; }
footer p { margin: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--ink); }

@media (max-width: 760px) {
  body { padding: 24px 18px 18px; }
  .masthead { align-items: flex-start; }
  .masthead-status { flex-direction: column; align-items: flex-end; gap: 6px; }
  .auth-panel { grid-template-columns: 1fr; gap: 26px; padding: 34px 0; }
  .toolbar { align-items: flex-start; }
  .toolbar-actions { justify-content: flex-start; }
  .summary-ledger, .state-ledger { grid-template-columns: repeat(2, 1fr); }
  .summary-ledger div:nth-child(3) { padding-left: 0; border-left: 0; border-top: 1px solid var(--rule-subtle); }
  .summary-ledger div:nth-child(4) { border-top: 1px solid var(--rule-subtle); }
  .state-ledger div:nth-child(odd) { padding-left: 0; }
  .state-ledger div:nth-child(even) { padding-left: 16px; }
  section { padding-top: 38px; }
}

@media (max-width: 480px) {
  .masthead { display: block; }
  .masthead-status { flex-direction: row; justify-content: space-between; align-items: center; margin-top: 18px; }
  .key-entry { grid-template-columns: 1fr; gap: 8px; }
  .key-entry input { border-right: 1px solid var(--rule); border-radius: 4px; }
  .key-entry button { border-radius: 4px; }
  .toolbar { display: block; }
  .toolbar-actions { margin-top: 8px; gap: 4px 16px; }
  .section-heading { align-items: flex-start; }
  .summary-ledger { grid-template-columns: 1fr 1fr; }
  .summary-ledger div { padding-right: 10px; }
  .summary-ledger div + div { padding-left: 10px; }
  .state-ledger { grid-template-columns: 1fr; }
  .state-ledger div, .state-ledger div:nth-child(even) { padding-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: oklch(20% 0.008 72);
    --paper-muted: oklch(23% 0.009 72);
    --ink: oklch(94% 0.008 78);
    --ink-muted: oklch(73% 0.009 78);
    --ink-faint: oklch(59% 0.009 78);
    --rule: oklch(40% 0.01 72);
    --rule-subtle: oklch(29% 0.009 72);
    --focus: oklch(72% 0.09 245);
    --success-bg: oklch(29% 0.055 155);
    --success-ink: oklch(79% 0.08 155);
    --active-bg: oklch(31% 0.05 75);
    --active-ink: oklch(81% 0.09 88);
    --danger-bg: oklch(29% 0.045 28);
    --danger-ink: oklch(79% 0.075 28);
    --neutral-bg: oklch(29% 0.009 72);
    --neutral-ink: oklch(73% 0.009 78);
  }
}`

const DASHBOARD_JS = `(() => {
  'use strict'

  const POLL_INTERVAL_MS = 5000
  const KEY_STORAGE = 'yearn-prices-daily-price-api-key'
  const stateLabels = {
    idle: ['Idle', 'status-neutral'],
    queued: ['Queued', 'status-neutral'],
    running: ['Active', 'status-active'],
    waiting_retry: ['Waiting for retry', 'status-warning'],
    stalled: ['No recent activity', 'status-danger'],
    complete: ['Complete', 'status-success'],
  }
  const outcomeLabels = {
    priced: 'Priced',
    unsupported: 'Unsupported',
    retryable: 'Retryable',
    quarantined: 'Quarantined',
    in_progress: 'In progress',
    pending: 'Pending',
  }

  const element = id => document.getElementById(id)
  const authPanel = element('auth-panel')
  const dashboard = element('dashboard')
  const keyForm = element('key-form')
  const keyInput = element('api-key')
  const authError = element('auth-error')
  const dashboardError = element('dashboard-error')
  const refreshButton = element('refresh-button')
  const pauseButton = element('pause-button')
  const forgetButton = element('forget-button')
  let apiKey = readSessionKey()
  let pollingPaused = false
  let pollTimer = null
  let requestInFlight = false

  function readSessionKey() {
    try { return sessionStorage.getItem(KEY_STORAGE) || '' } catch { return '' }
  }

  function writeSessionKey(value) {
    try { sessionStorage.setItem(KEY_STORAGE, value) } catch { /* session storage may be disabled */ }
  }

  function clearSessionKey() {
    try { sessionStorage.removeItem(KEY_STORAGE) } catch { /* session storage may be disabled */ }
  }

  function count(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value || 0)
  }

  function percent(value, digits = 2) {
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value || 0) + '%'
  }

  function rate(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value || 0) + ' / min'
  }

  function duration(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'Unavailable'
    if (seconds < 60) return '< 1 minute'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes + ' min'
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    if (hours < 48) return hours + 'h ' + remainingMinutes + 'm'
    const days = Math.floor(hours / 24)
    return days + 'd ' + (hours % 24) + 'h'
  }

  function dateTime(timestamp) {
    if (timestamp == null) return 'Unavailable'
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp * 1000)
  }

  function relativeTime(timestamp) {
    if (timestamp == null) return 'Unavailable'
    const seconds = Math.round(timestamp - Date.now() / 1000)
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
    const minutes = Math.round(seconds / 60)
    if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
    return formatter.format(Math.round(minutes / 60), 'hour')
  }

  function shortAddress(address) {
    return address && address.length > 12 ? address.slice(0, 6) + '…' + address.slice(-4) : address || 'Unknown'
  }

  function titleCase(value) {
    if (!value) return 'Unknown'
    return value.replaceAll('_', ' ').replaceAll('-', ' ').replace(/\\b\\w/g, letter => letter.toUpperCase())
  }

  function setText(id, value) {
    element(id).textContent = value
  }

  function cell(value, className) {
    const node = document.createElement('td')
    node.textContent = value
    if (className) node.className = className
    return node
  }

  function outcomeBadge(status) {
    const node = document.createElement('span')
    const className = status === 'priced'
      ? 'status-success'
      : status === 'retryable' || status === 'in_progress'
        ? 'status-warning'
        : status === 'quarantined'
          ? 'status-danger'
          : 'status-neutral'
    node.className = 'status ' + className
    node.textContent = outcomeLabels[status] || titleCase(status)
    return node
  }

  function renderTable(bodyId, rows, columns, emptyMessage) {
    const body = element(bodyId)
    body.replaceChildren()
    if (rows.length === 0) {
      const row = document.createElement('tr')
      row.className = 'empty-row'
      const empty = cell(emptyMessage)
      empty.colSpan = columns
      row.append(empty)
      body.append(row)
      return
    }
    body.append(...rows)
  }

  function render(snapshot) {
    const queue = snapshot.queue
    const runState = stateLabels[snapshot.state] || stateLabels.idle
    const badge = element('run-state')
    badge.className = 'status ' + runState[1]
    badge.textContent = runState[0]
    setText('sync-time', 'Updated ' + relativeTime(snapshot.generatedAt))
    setText('activity-note', snapshot.activity.lastActivityAt == null
      ? 'No worker activity has been recorded.'
      : 'Last queue activity ' + relativeTime(snapshot.activity.lastActivityAt) + '. Host process state is not inspected.')

    const completion = Math.min(Math.max(queue.completionPercent, 0), 100)
    setText('progress-value', percent(completion))
    element('progress-fill').style.width = completion + '%'
    element('progress-track').setAttribute('aria-valuenow', completion.toFixed(2))
    setText('resolved-value', count(queue.resolved))
    setText('remaining-value', count(queue.remaining))
    setText('rate-value', rate(snapshot.activity.ratePerMinute.fiveMinutes))
    setText('eta-value', duration(snapshot.activity.etaSeconds))
    setText('queue-total', count(queue.total) + ' targets')
    setText('priced-value', count(queue.priced))
    setText('pending-value', count(queue.pending))
    setText('in-progress-value', count(queue.inProgress))
    setText('unsupported-value', count(queue.unsupported))
    setText('retryable-value', count(queue.retryable))
    setText('quarantined-value', count(queue.quarantined))
    setText('active-leases-value', count(queue.activeLeases))
    setText('expired-leases-value', count(queue.expiredLeases))

    renderTable('chains-body', snapshot.chains.map(chain => {
      const row = document.createElement('tr')
      row.append(
        cell(titleCase(chain.chain)),
        cell(count(chain.total), 'numeric'),
        cell(count(chain.resolved), 'numeric'),
        cell(count(chain.remaining), 'numeric'),
        cell(count(chain.priced), 'numeric'),
        cell(count(chain.unsupported), 'numeric'),
        cell(count(chain.retryable), 'numeric'),
      )
      return row
    }), 7, 'No daily price targets have been imported.')

    renderTable('adapters-body', snapshot.adapters.map(adapter => {
      const row = document.createElement('tr')
      row.append(cell(adapter.adapter, 'mono'), cell(count(adapter.count), 'numeric'), cell(percent(adapter.pricedPercent, 1), 'numeric'))
      return row
    }), 3, 'No adapters have written prices yet.')

    renderTable('sources-body', snapshot.sources.map(source => {
      const row = document.createElement('tr')
      row.append(cell(source.source, 'mono'), cell(count(source.count), 'numeric'), cell(percent(source.pricedPercent, 1), 'numeric'))
      return row
    }), 3, 'No source counts are available yet.')

    renderTable('qualities-body', snapshot.qualities.map(quality => {
      const row = document.createElement('tr')
      row.append(cell(quality.quality, 'mono'), cell(count(quality.count), 'numeric'), cell(percent(quality.pricedPercent, 1), 'numeric'))
      return row
    }), 3, 'No quality counts are available yet.')

    renderTable('active-body', snapshot.active.map(target => {
      const row = document.createElement('tr')
      const token = cell(shortAddress(target.token), 'mono muted')
      token.title = target.token
      row.append(
        cell(titleCase(target.chain)),
        token,
        cell(dateTime(target.eodAt), 'mono'),
        cell(relativeTime(target.lastAttemptAt), 'mono muted'),
        cell(relativeTime(target.leaseExpiresAt), 'mono muted'),
      )
      return row
    }), 5, 'No unexpired leases are visible.')

    renderTable('failures-body', snapshot.failures.map(failure => {
      const row = document.createElement('tr')
      const outcome = document.createElement('td')
      outcome.append(outcomeBadge(failure.status))
      row.append(
        outcome,
        cell(titleCase(failure.failureClass)),
        cell(titleCase(failure.resolutionFailure)),
        cell(count(failure.count), 'numeric'),
      )
      return row
    }), 4, 'No categorized failures are recorded.')

    renderTable('recent-body', snapshot.recent.map(result => {
      const row = document.createElement('tr')
      const outcome = document.createElement('td')
      outcome.append(outcomeBadge(result.status))
      const token = cell(shortAddress(result.token), 'mono muted')
      token.title = result.token
      row.append(
        cell(relativeTime(result.updatedAt), 'mono muted'),
        outcome,
        cell(titleCase(result.chain)),
        token,
        cell(dateTime(result.eodAt), 'mono'),
        cell(result.adapter || result.failureReason || titleCase(result.resolutionFailure || result.failureClass), 'mono'),
      )
      return row
    }), 6, 'No target outcomes are recorded.')
  }

  function schedulePoll() {
    clearTimeout(pollTimer)
    if (!pollingPaused && apiKey) pollTimer = setTimeout(loadSnapshot, POLL_INTERVAL_MS)
  }

  async function loadSnapshot() {
    if (!apiKey || requestInFlight) return
    requestInFlight = true
    refreshButton.disabled = true
    dashboardError.hidden = true
    try {
      const response = await fetch('/api/daily-prices/progress', {
        headers: { authorization: 'Bearer ' + apiKey },
        cache: 'no-store',
      })
      if (response.status === 401) {
        authPanel.hidden = false
        dashboard.hidden = true
        authError.textContent = 'That API key was not accepted.'
        keyInput.focus()
        return
      }
      if (!response.ok) throw new Error('Progress endpoint returned HTTP ' + response.status)
      const snapshot = await response.json()
      render(snapshot)
      authError.textContent = ''
      authPanel.hidden = true
      dashboard.hidden = false
    } catch (error) {
      dashboardError.textContent = error instanceof Error ? error.message : 'Could not load progress.'
      dashboardError.hidden = false
    } finally {
      requestInFlight = false
      refreshButton.disabled = false
      schedulePoll()
    }
  }

  keyForm.addEventListener('submit', event => {
    event.preventDefault()
    apiKey = keyInput.value.trim()
    if (!apiKey) return
    writeSessionKey(apiKey)
    loadSnapshot()
  })

  refreshButton.addEventListener('click', loadSnapshot)

  pauseButton.addEventListener('click', () => {
    pollingPaused = !pollingPaused
    pauseButton.setAttribute('aria-pressed', String(pollingPaused))
    pauseButton.textContent = pollingPaused ? 'Resume polling' : 'Pause polling'
    if (pollingPaused) clearTimeout(pollTimer)
    else loadSnapshot()
  })

  forgetButton.addEventListener('click', () => {
    clearTimeout(pollTimer)
    clearSessionKey()
    apiKey = ''
    keyInput.value = ''
    dashboard.hidden = true
    authPanel.hidden = false
    setText('run-state', 'Not connected')
    element('run-state').className = 'status status-neutral'
    setText('sync-time', 'Waiting for credentials')
    keyInput.focus()
  })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !pollingPaused) loadSnapshot()
  })

  if (apiKey) {
    keyInput.value = apiKey
    loadSnapshot()
  } else {
    keyInput.focus()
  }
})()`

const NO_STORE_HEADERS = { 'cache-control': 'no-store' }

export function handleDailyPriceDashboardAsset(pathname: string, method: string): Response | null {
  if (method !== 'GET') return null

  if (pathname === '/daily-prices' || pathname === '/daily-prices/') {
    return new Response(DASHBOARD_HTML, {
      headers: {
        ...NO_STORE_HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  if (pathname === '/daily-prices/styles.css') {
    return new Response(DASHBOARD_CSS, {
      headers: { ...NO_STORE_HEADERS, 'content-type': 'text/css; charset=utf-8', 'x-content-type-options': 'nosniff' },
    })
  }

  if (pathname === '/daily-prices/app.js') {
    return new Response(DASHBOARD_JS, {
      headers: { ...NO_STORE_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' },
    })
  }

  return null
}
