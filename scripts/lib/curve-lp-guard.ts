import type { FinalizationResolution, FinalizationTarget } from '../../src/backfill/finalize'
import { getChainClient } from '../../src/clients/rpc'
import { getBatchHistoricalPrices, type QueryExecutor } from '../../src/db/queries'
import { createCurveLpGuard, type PlausibleQuote } from '../../src/sources/defillama/lp-guard'
import type { TokenPriceWrite } from '../../src/types'
import { chainIdToName, chainNameToId, normalizeTokenAddress } from '../../src/utils'

export function storedCurveLpGuard(pool: QueryExecutor): PlausibleQuote {
  return createCurveLpGuard({
    clientForChain: (chainId) => getChainClient(chainId),
    coinPrices: async (chainId, coins, timestamp) => {
      const chain = chainIdToName(chainId)
      if (!chain) return coins.map(() => null)
      const tokens = coins.map((coin) => normalizeTokenAddress(coin))
      const rows = await getBatchHistoricalPrices(
        pool,
        tokens.map((token) => ({ chain, token, timestamp }))
      )
      return tokens.map((token) => rows.find((row) => row.token.toLowerCase() === token.toLowerCase())?.price ?? null)
    }
  })
}

export function storedTargetGuard(
  pool: QueryExecutor
): (target: FinalizationTarget & { resolution: FinalizationResolution }) => Promise<boolean> {
  const guard = storedCurveLpGuard(pool)
  return (t) => guard(t.chainId, t.token, t.eodTimestamp, t.resolution.price)
}

export async function plausibleWrites(
  writes: TokenPriceWrite[],
  isPlausible: PlausibleQuote
): Promise<{ writes: TokenPriceWrite[]; rejected: TokenPriceWrite[] }> {
  const verdicts = await Promise.all(
    writes.map(async (write) => {
      const chainId = chainNameToId(write.chain)
      return (
        write.source !== 'defillama' ||
        chainId === undefined ||
        isPlausible(chainId, write.token, write.timestamp, Number(write.price))
      )
    })
  )
  const rejected = writes.filter((_, index) => !verdicts[index])
  for (const write of rejected) console.warn(`implausible-lp ${write.chain}:${write.token} ${write.timestamp}`)
  return { writes: writes.filter((_, index) => verdicts[index]), rejected }
}
