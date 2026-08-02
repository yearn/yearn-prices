import { config as loadEnv } from 'dotenv'
import { SUPPORTED_CHAIN_NAMES } from '../src/chains'
import { createPool } from '../src/db'
import { sanitizeFailureReason } from '../src/daily-price-dashboard'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

interface CountRow {
  name: string
  count: string | number
}

interface ChainRow {
  chain: string
  total: string | number
  priced: string | number
  production_priced: string | number
  unsupported: string | number
  retryable: string | number
  quarantined: string | number
  pending: string | number
  in_progress: string | number
}

interface FailureRow {
  chain: string
  token: string
  status: string
  failure_class: string | null
  adapter: string | null
  resolution_failure: string | null
  failure_reason: string | null
  asset_days: string | number
}

function countMap(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map(row => [row.name, Number(row.count)]))
}

const pool = createPool(databaseUrl)
try {
  const [
    chainResult,
    sourceResult,
    adapterResult,
    qualityResult,
    classificationResult,
    failureResult,
    importResult,
    proxyResult,
  ] = await Promise.all([
    pool.query<ChainRow>(`
      SELECT
        chain,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'priced') AS priced,
        COUNT(*) FILTER (
          WHERE status = 'priced' AND adapter = 'production-yearn-prices-import'
        ) AS production_priced,
        COUNT(*) FILTER (WHERE status = 'unsupported') AS unsupported,
        COUNT(*) FILTER (WHERE status = 'retryable') AS retryable,
        COUNT(*) FILTER (WHERE status = 'quarantined') AS quarantined,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress
      FROM daily_price_targets
      GROUP BY chain
      ORDER BY chain
    `),
    pool.query<CountRow>(`
      SELECT COALESCE(metadata->>'source', 'unknown') AS name, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY name
      ORDER BY count DESC, name
    `),
    pool.query<CountRow>(`
      SELECT COALESCE(adapter, 'unknown') AS name, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY name
      ORDER BY count DESC, name
    `),
    pool.query<CountRow>(`
      SELECT COALESCE(metadata->>'quality', 'unknown') AS name, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY name
      ORDER BY count DESC, name
    `),
    pool.query<CountRow>(`
      SELECT COALESCE(metadata->>'classification', 'legacy') AS name, COUNT(*) AS count
      FROM daily_price_targets
      WHERE status = 'priced'
      GROUP BY name
      ORDER BY count DESC, name
    `),
    pool.query<FailureRow>(`
      SELECT
        chain,
        token,
        status,
        failure_class,
        adapter,
        metadata->>'resolutionFailure' AS resolution_failure,
        failure_reason,
        COUNT(*) AS asset_days
      FROM daily_price_targets
      WHERE status IN ('unsupported', 'retryable', 'quarantined')
      GROUP BY chain, token, status, failure_class, adapter, resolution_failure, failure_reason
      ORDER BY status, asset_days DESC, chain, token
    `),
    pool.query<CountRow>(`
      SELECT COALESCE(metadata->>'importClassification', 'unknown') AS name, COUNT(*) AS count
      FROM daily_price_targets
      GROUP BY name
      ORDER BY count DESC, name
    `),
    pool.query<{
      chain: string
      token: string
      source: string
      metadata: Record<string, unknown> | null
      first_eod: string | Date
      last_eod: string | Date
      asset_days: string | number
    }>(`
      SELECT
        chain,
        token,
        source,
        evidence_metadata AS metadata,
        MIN(timestamp) AS first_eod,
        MAX(timestamp) AS last_eod,
        COUNT(*) AS asset_days
      FROM token_prices
      WHERE source IN ('defillama-coingecko-alias', 'defillama-canonical-market-proxy')
        AND validation_status = 'validated'
      GROUP BY chain, token, source, evidence_metadata
      ORDER BY chain, token, first_eod
    `),
  ])

  const actualChains = new Set(chainResult.rows.map(row => row.chain))
  const failures = failureResult.rows.map(row => ({
    chain: row.chain,
    token: row.token,
    status: row.status,
    failureClass: row.failure_class,
    resolutionFailure: row.resolution_failure,
    adapter: row.adapter,
    reason: sanitizeFailureReason(row.failure_reason),
    assetDays: Number(row.asset_days),
  }))
  const failuresByOutcome = failures.reduce<Record<string, typeof failures>>((groups, failure) => {
    const group = groups[failure.status] ?? []
    group.push(failure)
    groups[failure.status] = group
    return groups
  }, {})

  console.info(JSON.stringify({
    generatedAt: new Date().toISOString(),
    supportedChains: [...SUPPORTED_CHAIN_NAMES],
    chainsWithTargets: [...actualChains],
    chainsWithoutTargets: [...SUPPORTED_CHAIN_NAMES].filter(chain => !actualChains.has(chain)),
    byChain: chainResult.rows.map(row => ({
      chain: row.chain,
      total: Number(row.total),
      startingPriced: Number(row.production_priced),
      endingPriced: Number(row.priced),
      unsupported: Number(row.unsupported),
      retryable: Number(row.retryable),
      quarantined: Number(row.quarantined),
      pending: Number(row.pending),
      inProgress: Number(row.in_progress),
    })),
    pricedBySource: countMap(sourceResult.rows),
    pricedByAdapter: countMap(adapterResult.rows),
    pricedByQuality: countMap(qualityResult.rows),
    pricedByClassification: countMap(classificationResult.rows),
    productionImports: countMap(importResult.rows),
    failures: failuresByOutcome,
    explicitMappingsAndProxies: proxyResult.rows.map(row => ({
      chain: row.chain,
      token: row.token,
      source: row.source,
      firstEod: new Date(row.first_eod).toISOString(),
      lastEod: new Date(row.last_eod).toISOString(),
      assetDays: Number(row.asset_days),
      evidence: row.metadata,
    })),
  }, null, 2))
} finally {
  await pool.end()
}
