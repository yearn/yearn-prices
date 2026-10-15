import type { FinalizationResolution, FinalizationTarget } from '../../src/backfill/finalize'
import { getChainClient } from '../../src/clients/rpc'
import type { QueryExecutor } from '../../src/db/queries'
import { ACCEPTED_PRICE_SQL, isRejectedPrice } from '../../src/prices/rejections'
import { createCurveLpGuard, type PlausibleQuote } from '../../src/sources/defillama/lp-guard'
import { isDefiLlamaSource, SOURCE_PRIORITY, type TokenPriceWrite } from '../../src/types'
import { chainIdToName, chainNameToId, normalizeTokenAddress, unixToIsoTimestamp } from '../../src/utils'

export function storedCurveLpGuard(pool: QueryExecutor): PlausibleQuote {
  return createCurveLpGuard({
    clientForChain: (chainId) => getChainClient(chainId),
    coinPrices: async (chainId, coins, timestamp) => {
      const chain = chainIdToName(chainId)
      if (!chain) return coins.map(() => null)
      const tokens = coins.map((coin) => normalizeTokenAddress(coin))
      const { rows } = await pool.query<{ token: string; price: string | number }>(
        `SELECT DISTINCT ON (token) token, price FROM token_prices tp
         WHERE chain = $1 AND token = ANY($2::text[]) AND timestamp = $3::timestamptz
           AND ${ACCEPTED_PRICE_SQL}
         ORDER BY token, source LIKE 'defillama%', array_position($4::text[], source)`,
        [chain, tokens, unixToIsoTimestamp(timestamp), [...SOURCE_PRIORITY]]
      )
      return tokens.map((token) => {
        const row = rows.find((r) => r.token.toLowerCase() === token.toLowerCase())
        return row ? Number(row.price) : null
      })
    }
  })
}

export function storedTargetGuard(
  pool: QueryExecutor
): (target: FinalizationTarget & { resolution: FinalizationResolution }) => Promise<boolean> {
  const guard = storedCurveLpGuard(pool)
  return async (t) =>
    !isRejectedPrice(t.chain, t.token, t.eodTimestamp, t.resolution.source) &&
    guard(t.chainId, t.token, t.eodTimestamp, t.resolution.price)
}

export async function plausibleWrites(
  writes: TokenPriceWrite[],
  isPlausible: PlausibleQuote
): Promise<{ writes: TokenPriceWrite[]; rejected: TokenPriceWrite[] }> {
  const verdicts = await Promise.all(
    writes.map(async (write) => {
      if (isRejectedPrice(write.chain, write.token, write.timestamp, write.source)) return false
      const chainId = chainNameToId(write.chain)
      return (
        !isDefiLlamaSource(write.source) ||
        chainId === undefined ||
        isPlausible(chainId, write.token, write.timestamp, Number(write.price))
      )
    })
  )
  const rejected = writes.filter((_, index) => !verdicts[index])
  for (const write of rejected) console.warn(`implausible-lp ${write.chain}:${write.token} ${write.timestamp}`)
  return { writes: writes.filter((_, index) => verdicts[index]), rejected }
}
