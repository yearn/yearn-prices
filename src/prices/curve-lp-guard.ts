import { sql } from 'drizzle-orm'
import { getChainClient } from '../clients/rpc'
import { executeSql } from '../db/orm'
import type { QueryExecutor } from '../db/queries'
import { createCurveLpGuard, type PlausibleQuote } from '../sources/defillama/lp-guard'
import { SOURCE_PRIORITY, type TokenPriceWrite } from '../types'
import { chainIdToName, chainNameToId, normalizeTokenAddress, unixToIsoTimestamp } from '../utils'
import { ACCEPTED_PRICE_SQL, isRejectedPrice } from './rejections'

export function storedCurveLpGuard(pool: QueryExecutor, env?: Record<string, string | undefined>): PlausibleQuote {
  return createCurveLpGuard({
    clientForChain: (chainId) => getChainClient(chainId, env),
    coinPrices: async (chainId, coins, timestamp) => {
      const chain = chainIdToName(chainId)
      if (!chain) return coins.map(() => null)
      const tokens = coins.map((coin) => normalizeTokenAddress(coin))
      const { rows } = await executeSql<{ token: string; price: string | number }>(
        pool,
        sql`SELECT DISTINCT ON (token) token, price FROM token_prices tp
         WHERE chain = ${chain} AND token = ANY(${sql.param(tokens)}::text[]) AND timestamp = ${unixToIsoTimestamp(timestamp)}::timestamptz
           AND ${ACCEPTED_PRICE_SQL}
         ORDER BY token, source LIKE 'defillama%', array_position(${sql.param([...SOURCE_PRIORITY])}::text[], source)`
      )
      return tokens.map((token) => {
        const row = rows.find((r) => r.token.toLowerCase() === token.toLowerCase())
        return row ? Number(row.price) : null
      })
    }
  })
}

export async function plausibleWrites(
  writes: TokenPriceWrite[],
  isPlausible: PlausibleQuote
): Promise<{ writes: TokenPriceWrite[]; rejected: TokenPriceWrite[] }> {
  const verdicts = await Promise.all(
    writes.map(async (write) => {
      if (isRejectedPrice(write.chain, write.token, write.timestamp, write.source)) return false
      const chainId = chainNameToId(write.chain)
      return chainId === undefined || isPlausible(chainId, write.token, write.timestamp, Number(write.price))
    })
  )
  const rejected = writes.filter((_, index) => !verdicts[index])
  for (const write of rejected) console.warn(`implausible-lp ${write.chain}:${write.token} ${write.timestamp}`)
  return { writes: writes.filter((_, index) => verdicts[index]), rejected }
}
