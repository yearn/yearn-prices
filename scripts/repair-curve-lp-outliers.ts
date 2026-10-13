import { parseArgs } from 'node:util'
import { config } from 'dotenv'

config({ quiet: true })

import { getChainClient } from '../src/clients/rpc'
import { createPool, getBatchHistoricalPrices, insertTokenPrices } from '../src/db'
import { createOnchainHistoricalSource, ONCHAIN_SOURCE_NAME } from '../src/sources/onchain'
import type { HistoricalPriceResult } from '../src/sources/types'
import type { MarketPriceResolver } from '../src/sources/onchain/types'
import { normalizeTokenAddress, unixToIsoTimestamp } from '../src/utils'
import { storedCurveLpGuard } from './lib/curve-lp-guard'
import { storedHistoricalPrices } from './lib/stored-historical-prices'

const CHAIN = 'ethereum'
const CHAIN_ID = 1

const YBUSD_LP = '0x3b3ac5386837dc563660fb6a0937dfaa5924333b'
const YBUSD_DAYS = [1780444799, 1780531199, 1780617599, 1780703999, 1780790399, 1780876799, 1780963199, 1781049599]

const DEC_2023_DAY = 1703116799
const DEC_2023_LPS = [
  '0x02d341ccb60faaf662bc0554d13778015d1b285c',
  '0x051d7e5609917bd9b73f04bac0ded8dd46a74301',
  '0x067079c14b85169e6a29703769daddef90816f4c',
  '0x390f3595bca2df7d23783dfd126427cceb997bf4',
  '0x3a283d9c08e8b55966afb64c515f5143cf907611',
  '0x3d229e1b4faab62f621ef2f6a610961f7bd7b23b',
  '0x4acc1bf7d6a591016641325aa6664a1cd178f002',
  '0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14',
  '0x5282a4ef67d9c33135340fb3289cc1711c13638c',
  '0x5b5cfe992adac0c9d48e05854b2d91c73a003858',
  '0x6e0e681441be6cb1d8405752462488bd4d691e3a',
  '0x971add32ea87f10bd192671630be3be8a11b8623',
  '0x9978c6b08d28d3b74437c917c5dd7c026df9d55c',
  '0xb19059ebb43466c323583928285a49f558e572fd',
  '0xbe4f3ad6c9458b901c81b734cb22d9eae9ad8b50',
  '0xde5331ac4b3630f94853ff322b66407e0d6331e8',
  '0xecdd0ce505da71cd9de855cd6804ba1e8c7bdb07',
  '0xf5f5b97624542d72a9e06f04804bf81baa15e2b4',
  '0xfed2b54453f75634bcdaea5e5b11a3f99b9c28fa'
]

const YETH_LP = '0x69accb968b19a53790f43e57558f5e443a91af22'
const YETH_DAY = 1769731199

interface Outlier {
  token: string
  timestamp: number
  rederive: boolean
}

const outliers: Outlier[] = [
  ...YBUSD_DAYS.map((timestamp) => ({ token: YBUSD_LP, timestamp, rederive: true })),
  ...DEC_2023_LPS.map((token) => ({ token, timestamp: DEC_2023_DAY, rederive: true })),
  { token: YETH_LP, timestamp: YETH_DAY, rederive: false }
]

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    'database-url-env': { type: 'string', default: 'DATABASE_URL' }
  }
})
const databaseUrl = process.env[values['database-url-env'] as string]
if (!databaseUrl) throw new Error('Missing database connection configuration')

const pool = createPool(databaseUrl)
const stored = storedHistoricalPrices(pool)
const affected = new Set(outliers.map((outlier) => outlier.token))
const marketPrice: MarketPriceResolver = async (target) => {
  if (affected.has(target.token.toLowerCase())) return null
  await stored.prefetch([target])
  return stored.get(target)
}
const onchain = createOnchainHistoricalSource({ marketPrice, clientForChain: (chainId) => getChainClient(chainId) })
const curveLpGuard = storedCurveLpGuard(pool)
const emit = (record: unknown) => console.info(JSON.stringify(record))

try {
  const tally = { deleted: 0, derived: 0, deleteOnly: 0, noop: 0 }
  for (const outlier of outliers) {
    const { token, timestamp } = outlier
    const request = { chain: CHAIN, token: normalizeTokenAddress(token), timestamp }
    const [row] = await getBatchHistoricalPrices(pool, [request], 'defillama')
    if (!row) {
      emit({ token, timestamp, skipped: 'no-defillama-row' })
      continue
    }
    const { rows: others } = await pool.query<{ source: string; price: string | number }>(
      `SELECT source, price FROM token_prices WHERE chain = $1 AND lower(token) = $2 AND timestamp = $3::timestamptz AND source <> 'defillama' ORDER BY source LIMIT 1`,
      [CHAIN, request.token.toLowerCase(), unixToIsoTimestamp(timestamp)]
    )
    const other = others[0]

    let derived: HistoricalPriceResult | null = null
    let derivedPrice: number | null = null
    let derivedNote: string | null = null
    if (outlier.rederive && !other) {
      try {
        derived = (await onchain.getHistoricalPrice(CHAIN_ID, token, timestamp)) ?? null
        derivedPrice = derived?.price ?? null
        if (derivedPrice == null) derivedNote = 'not-derivable'
        else if (!(await curveLpGuard(CHAIN_ID, token, timestamp, derivedPrice))) {
          derivedNote = 'derived-implausible'
          derivedPrice = null
        }
      } catch (error) {
        derivedNote = `derive-failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    emit({
      token,
      timestamp,
      storedDefillama: row.price,
      existingOther: other ? { source: other.source, price: Number(other.price) } : null,
      derivedPrice,
      derivedNote
    })
    if (!values.write) continue
    if (outlier.rederive && !other && derivedPrice == null) continue

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `DELETE FROM token_prices WHERE chain = $1 AND lower(token) = $2 AND timestamp = $3::timestamptz AND source = 'defillama'`,
        [CHAIN, request.token.toLowerCase(), unixToIsoTimestamp(timestamp)]
      )
      if (derived && derivedPrice != null) {
        await insertTokenPrices(client, [
          {
            chain: CHAIN,
            token: request.token,
            timestamp,
            price: derivedPrice,
            symbol: derived.symbol ?? row.symbol,
            confidence: derived.confidence,
            source: ONCHAIN_SOURCE_NAME
          }
        ])
      }
      await client.query('COMMIT')
      tally.deleted += rowCount ?? 0
      if (derivedPrice != null) tally.derived += 1
      else if ((rowCount ?? 0) > 0) tally.deleteOnly += 1
      else tally.noop += 1
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  emit({ type: 'summary', mode: values.write ? 'write' : 'dry-run', targets: outliers.length, ...tally })
} finally {
  await pool.end()
}
