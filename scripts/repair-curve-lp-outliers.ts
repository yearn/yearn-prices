import { parseArgs } from 'node:util'
import { config } from 'dotenv'

config({ quiet: true })

import { getChainClient } from '../src/clients/rpc'
import { createPool } from '../src/db'
import { REJECTED_OBSERVATIONS } from '../src/prices/rejections'
import { createOnchainPriceAdapters, RecursivePriceEngine } from '../src/sources/onchain'
import { createReadBudget } from '../src/sources/onchain/read-budget'
import type { MarketPriceResolver } from '../src/sources/onchain/types'
import { normalizeTokenAddress } from '../src/utils'
import { repairCurveLpOutlier } from './lib/repair-curve-lp'
import { storedHistoricalPrices } from './lib/stored-historical-prices'

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    'database-url-env': { type: 'string', default: 'DATABASE_URL' }
  }
})
const databaseUrl = process.env[values['database-url-env']]
if (!databaseUrl) throw new Error('Missing database connection configuration')

const pool = createPool(databaseUrl)
const stored = storedHistoricalPrices(pool)
const marketPrice: MarketPriceResolver = async (target) => {
  await stored.prefetch([target])
  return stored.get(target)
}
const emit = (record: unknown) => console.info(JSON.stringify(record))

try {
  const tally: Record<string, number> = {}
  let quarantined = 0
  for (const target of REJECTED_OBSERVATIONS) {
    const result = await repairCurveLpOutlier(pool, target, values.write, async () => {
      const client = getChainClient(target.chainId)
      if (!client) throw new Error(`RPC_URL_${target.chainId} is required for replacement pricing`)
      // Budgets and historical context belong to one target, not the whole run.
      const metered = createReadBudget(400).meter(client)
      const adapters = createOnchainPriceAdapters({
        clientForChain: (chainId) => (chainId === target.chainId ? metered : null),
        blockContextCache: new Map()
      }).map((adapter) => ({
        ...adapter,
        resolve: (request: Parameters<typeof adapter.resolve>[0], context: Parameters<typeof adapter.resolve>[1]) =>
          request.token.toLowerCase() === target.token && adapter.name !== 'curve-reserve-nav'
            ? Promise.resolve(null)
            : adapter.resolve(request, context)
      }))
      const engine = new RecursivePriceEngine(marketPrice, adapters, 8, new Map(), 256)
      const resolved = await engine.resolve({
        chainId: target.chainId,
        token: normalizeTokenAddress(target.token),
        timestamp: target.timestamp
      })
      if (!resolved.path) throw new Error(`Derivation unavailable: ${resolved.failure.reason}`)
      return resolved.path
    })
    tally[result.status] = (tally[result.status] ?? 0) + 1
    quarantined += result.quarantined
    emit({ type: 'target', target, ...result })
    if (result.status === 'unresolved') process.exitCode = 1
  }
  emit({
    type: 'summary',
    mode: values.write ? 'write' : 'dry-run',
    targets: REJECTED_OBSERVATIONS.length,
    quarantinedRows: quarantined,
    statuses: tally
  })
} finally {
  await pool.end()
}
