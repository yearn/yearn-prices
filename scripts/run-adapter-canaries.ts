import { config as loadEnv } from 'dotenv'
import { normalizeTokenAddress } from '../src/chains'
import { createPool } from '../src/db'
import { createHistoricalMarketPriceResolver } from '../src/historical-market'
import { createOnchainPriceAdapters } from '../src/onchain-price-adapters'
import { RecursivePriceEngine, type HistoricalMarketPriceResolver } from '../src/recursive-pricing'
import { getChainClient, validateConfiguredRpcChainIds } from '../src/rpc'
import { latestClosedUtcDayEnd } from '../src/time'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

interface AdapterCanary {
  name: string
  adapter: string
  chain: string
  token: string
}

const CANARIES: AdapterCanary[] = [
  {
    name: 'Beets Bar fBEETS',
    adapter: 'beets-bar-share-rate',
    chain: 'fantom',
    token: '0xfcef8a994209d6916eb2c86cdd2afd60aa6f54b1',
  },
  {
    name: 'Yearn V3 yvUSDC',
    adapter: 'erc4626-convert-to-assets',
    chain: 'ethereum',
    token: '0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204',
  },
  {
    name: 'Yearn V2 yvDAI',
    adapter: 'yearn-share-rate',
    chain: 'ethereum',
    token: '0xdA816459F1AB5631232FE5e97a05BBBb94970c95',
  },
  {
    name: 'Compound cDAI',
    adapter: 'compound-exchange-rate',
    chain: 'ethereum',
    token: '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643',
  },
  {
    name: 'Iron Bank cyUSDC',
    adapter: 'compound-exchange-rate',
    chain: 'ethereum',
    token: '0x76Eb2Fe28b36B3ee97F3Adae0C69606eedb2A37c',
  },
  {
    name: 'Aave V2 aUSDC',
    adapter: 'aave-underlying-parity',
    chain: 'ethereum',
    token: '0xBcca60bB61934080951369a648Fb03DF4F96263C',
  },
  {
    name: 'Lido wstETH',
    adapter: 'wsteth-rate',
    chain: 'ethereum',
    token: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
  },
  {
    name: 'Uniswap V2 USDC-WETH LP',
    adapter: 'amm-reserve-nav',
    chain: 'ethereum',
    token: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
  },
  {
    name: 'Curve 3pool LP',
    adapter: 'curve-reserve-nav',
    chain: 'ethereum',
    token: '0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490',
  },
  {
    name: 'Balancer wstETH-WETH BPT',
    adapter: 'balancer-v2-vault-nav',
    chain: 'ethereum',
    token: '0x32296969Ef14EB0c6d29669C550D4a0449130230',
  },
  {
    name: 'Pendle NUSD market',
    adapter: 'pendle-oracle-lp-to-asset',
    chain: 'ethereum',
    token: '0x01d143a7665bb5ae93fbb3120f1f679bb5ad6164',
  },
]

function exactEodFromArgs(): number {
  const flagIndex = process.argv.indexOf('--eod')
  if (flagIndex < 0) return latestClosedUtcDayEnd()
  const parsed = Number(process.argv[flagIndex + 1])
  if (!Number.isSafeInteger(parsed) || parsed !== latestClosedUtcDayEnd(parsed + 1)) {
    throw new Error('--eod must be an exact closed UTC day-end timestamp')
  }
  return parsed
}

await validateConfiguredRpcChainIds()
const requestedTimestamp = exactEodFromArgs()
const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)
try {
  const baseMarket = createHistoricalMarketPriceResolver(pool, {
    searchWidth: '6h',
    allowProductionDailyImport: true,
  })
  const adapters = createOnchainPriceAdapters({ clientForChain: getChainClient })
  const results: Array<Record<string, unknown>> = []

  for (const canary of CANARIES) {
    const token = normalizeTokenAddress(canary.token)
    const rootMarket = (async target => (
      target.chain === canary.chain && target.token.toLowerCase() === token.toLowerCase()
        ? null
        : baseMarket(target)
    )) as HistoricalMarketPriceResolver
    const adapter = adapters.find(candidate => candidate.name === canary.adapter)
    if (!adapter) throw new Error(`Adapter ${canary.adapter} is not registered`)
    const engine = new RecursivePriceEngine(rootMarket, [adapter], 6)
    const result = await engine.resolve({
      chain: canary.chain,
      token,
      requestedTimestamp,
    })
    if (!result.path) {
      results.push({
        name: canary.name,
        adapter: canary.adapter,
        chain: canary.chain,
        token,
        status: 'failed',
        failure: result.failure,
      })
      continue
    }
    results.push({
      name: canary.name,
      adapter: canary.adapter,
      chain: canary.chain,
      token,
      status: 'passed',
      eodTimestamp: requestedTimestamp,
      priceUsd: result.path.priceUsd,
      blockNumber: result.path.blockNumber,
      classification: result.path.classification,
      quality: result.path.quality,
      inputCount: result.path.inputs.length,
      inputTokens: result.path.inputs.map(input => `${input.chain}:${input.token}`),
      historicalBlock: result.path.metadata.historicalBlock,
    })
  }

  const failed = results.filter(result => result.status === 'failed').length
  console.info(JSON.stringify({
    message: 'adapter-canaries-complete',
    requestedTimestamp,
    passed: results.length - failed,
    failed,
    results,
  }, null, 2))
  if (failed > 0) process.exitCode = 1
} finally {
  await pool.end()
}
