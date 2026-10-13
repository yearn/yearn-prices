import { getChainClient } from '../../src/clients/rpc'
import { getBatchHistoricalPrices, type QueryExecutor } from '../../src/db/queries'
import { createCurveLpGuard, type PlausibleQuote } from '../../src/sources/defillama/lp-guard'
import type { TokenPriceWrite } from '../../src/types'
import { chainIdToName, chainNameToId, normalizeTokenAddress } from '../../src/utils'

export function storedCurveLpGuard(pool: QueryExecutor): PlausibleQuote {
  return createCurveLpGuard({
    clientForChain: (chainId) => getChainClient(chainId),
    coinPrice: async (chainId, coin, timestamp) => {
      const chain = chainIdToName(chainId)
      if (!chain) return null
      const [row] = await getBatchHistoricalPrices(pool, [{ chain, token: normalizeTokenAddress(coin), timestamp }])
      return row?.price ?? null
    }
  })
}

export async function plausibleWrites(
  writes: TokenPriceWrite[],
  isPlausible: PlausibleQuote
): Promise<TokenPriceWrite[]> {
  const verdicts = await Promise.all(
    writes.map(
      async (write) =>
        write.source !== 'defillama' ||
        isPlausible(chainNameToId(write.chain) as number, write.token, write.timestamp, Number(write.price))
    )
  )
  return writes.filter((write, index) => {
    if (!verdicts[index]) console.warn(`gap:implausible-lp ${write.chain}:${write.token} ${write.timestamp}`)
    return verdicts[index]
  })
}
