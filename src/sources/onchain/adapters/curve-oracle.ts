import { type Address, parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  maybe,
  normalizedAddress,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { InvalidPricingError } from '../errors'
import { scaledRaw } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

/** Below this, a pool's EMA follows whoever trades last, not the market. */
export const MIN_QUOTE_LIQUIDITY_USD = 20_000

/**
 * Reviewed 2-coin pools whose EMA `price_oracle` prices a token when DefiLlama
 * has no observation. The other coin is priced without DefiLlama: a Chainlink
 * feed, an ERC4626 wrapper of one, or another pool listed here.
 */
export const CURVE_ORACLE_POOLS: Readonly<Record<number, Readonly<Record<string, Address>>>> = {
  1: {
    '0xfcc5c47be19d06bf83eb04298b026f81069ff65b': '0x99f5aCc8EC2Da2BC0771c32814EFF52b712de1E5',
    '0x6440f144b7e50d6a8439336510312d2f54beb01d': '0xEFc6516323FbD28e80B85A497B65A86243a54B3E',
    '0x57ab1e0003f623289cd798b1824be09a793e4bec': '0xc522A6606BBA746d7960404F22a3DB936B6F4F50',
    '0x64351fc9810adad17a690e4e1717df5e7e085160': '0xa4c567c662349BeC3D0fB94C4e7f85bA95E208e4',
    '0x63d74d22e689c715a04f2c13962b1f77f443d35b': '0x104d6a1b97A6CEf88D905d7b865A378d90be932A',
    '0xab5eb14c09d416f0ac63661e57edb7aecdb9befa': '0x9A9e2e70919c75D80aAaA1D483c46CdBb8ac4d1b',
    '0x22222222aea0076fca927a3f44dc0b4fdf9479d6': '0x5Ee9606e5611Fd6CE14BD2BC12db70BD53dC9daA',
    '0x01791f726b4103694969820be083196cc7c045ff': '0xec977F46467a3021785Cff88894886E617abd65b',
    '0xba3335588d9403515223f109edc4eb7269a9ab5d': '0x0E9B5B092caD6F1c5E6bc7f89Ffe1abb5c95F1C2',
    '0xf4c13d631450de6b12a19829e37c8e2826891dc4': '0xf76329c6dc10FdfbEe6CA520d0BF4d474E95E46E',
    '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5': '0xCA0253A98D16e9C1e3614caFDA19318EE69772D0',
    '0xe72b141df173b999ae7c1adcbf60cc9833ce56a8': '0x2c683fAd51da2cd17793219CC86439C1875c353e',
    '0x419905009e4656fdc02418c7df35b1e61ed5f726': '0xEe351f12EAE8C2B8B9d1B9BFd3c5dd565234578d',
    '0xbc6da0fe9ad5f3b0d58160288917aa56653660e9': '0x17F9682c9cd1a448b31C0428F1D0783eD13a9Fa3',
    '0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3': '0xcc7d5785AD5755B6164e21495E07aDb0Ff11C2A8',
    '0x2a8e1e676ec238d8a992307b495b45b3feaa5e86': '0x6d18E1a7faeB1F0467A77C0d293872ab685426dc',
    '0x5e8422345238f34275888049021821e8e08caa1f': '0x9c3B46C0Ceb5B9e304FCd6D88Fc50f7DD24B31Bc',
    '0x0100546f2cd4c9d97f798ffc9755e47865ff7ee6': '0x8eFD02a0a40545F32DbA5D664CbBC1570D3FedF6',
    '0x72953a5c32413614d24c29c84a66ae4b59581bbf': '0x342D1C4Aa76EA6F5E5871b7f11A019a0eB713A4f',
    '0x0d86883faf4ffd7aeb116390af37746f45b6f378': '0xE99810Cd5AdCD7b13455aE1BE678B382d61f2d1E',
    '0x64aa3364f17a4d01c6f1751fd97c2bd3d7e7f1d5': '0xFc1e8bf3E81383Ef07Be24c3FD146745719DE48D',
    '0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f': '0x08BfA22bB3e024CDfEB3eca53c0cb93bF59c4147'
  }
}

const poolAbi = parseAbi([
  'function coins(uint256 i) view returns (address)',
  'function balances(uint256 i) view returns (uint256)',
  'function stored_rates() view returns (uint256[])'
])
const indexedOracleAbi = parseAbi(['function price_oracle(uint256 i) view returns (uint256)'])
const oracleAbi = parseAbi(['function price_oracle() view returns (uint256)'])

/**
 * Stableswap-ng pools quote `price_oracle` in rate-scaled units (an ERC4626
 * coin counts at its share rate), so `stored_rates` turns it back into coin
 * units. Older and crypto pools have no rates and quote coin units directly.
 */
function rateMultiplier(rates: readonly bigint[] | null, index: number, decimals: number): number {
  if (!rates) return 1
  const rate = rates[index]
  if (rate == null || rate <= 0n) throw new InvalidPricingError('Curve pool has an invalid stored rate')
  return scaledRaw(rate, 36 - decimals)
}

export function curveOracleAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('curve-price-oracle', async (target) => {
    const pool = CURVE_ORACLE_POOLS[target.chainId]?.[target.token.toLowerCase()]
    if (!pool) return null
    const state = await contractContext(target, options)
    const { client, blockNumber } = state

    const [coin0Raw, coin1Raw] = await Promise.all(
      [0n, 1n].map((i) =>
        maybe(() => client.readContract({ address: pool, abi: poolAbi, functionName: 'coins', args: [i], blockNumber }))
      )
    )
    if (!coin0Raw || !coin1Raw) return null
    const coins = [normalizedAddress(coin0Raw), normalizedAddress(coin1Raw)]
    const index = coins.findIndex((coin) => coin?.toLowerCase() === target.token.toLowerCase())
    const quote = coins[1 - index]
    if (index < 0 || !quote) throw new InvalidPricingError(`Curve oracle pool ${pool} does not pair the token`)
    const quoteIndex = 1 - index

    let method = 'price_oracle(uint256)'
    let oracleRaw = await maybe(() =>
      client.readContract({
        address: pool,
        abi: indexedOracleAbi,
        functionName: 'price_oracle',
        args: [0n],
        blockNumber
      })
    )
    if (oracleRaw == null) {
      method = 'price_oracle()'
      oracleRaw = await maybe(() =>
        client.readContract({ address: pool, abi: oracleAbi, functionName: 'price_oracle', blockNumber })
      )
    }
    if (oracleRaw == null) return null
    if (oracleRaw <= 0n) throw new InvalidPricingError('Curve price oracle returned zero')

    const [rates, quoteBalanceRaw, decimals0, decimals1] = await Promise.all([
      maybe(() => client.readContract({ address: pool, abi: poolAbi, functionName: 'stored_rates', blockNumber })),
      maybe(() =>
        client.readContract({
          address: pool,
          abi: poolAbi,
          functionName: 'balances',
          args: [BigInt(quoteIndex)],
          blockNumber
        })
      ),
      tokenDecimals(client, coins[0] as string, blockNumber),
      tokenDecimals(client, coins[1] as string, blockNumber)
    ])
    if (quoteBalanceRaw == null) return null
    const coin1InCoin0 =
      (scaledRaw(oracleRaw, 18) * rateMultiplier(rates, 1, decimals1)) / rateMultiplier(rates, 0, decimals0)
    const tokenInQuote = index === 1 ? coin1InCoin0 : 1 / coin1InCoin0
    if (!Number.isFinite(tokenInQuote) || tokenInQuote <= 0) {
      throw new InvalidPricingError('Curve price oracle produced an invalid rate')
    }
    const quoteDecimals = quoteIndex === 0 ? decimals0 : decimals1

    const conversion = {
      ...blockEvidence(state, target),
      method,
      pool,
      quote,
      oracleRaw: rawState(oracleRaw),
      storedRates: rates?.map(rawState) ?? null,
      tokenInQuote,
      quoteBalanceRaw: rawState(quoteBalanceRaw),
      quoteDecimals
    }
    return {
      dependencies: [
        { target: childTarget(target, quote, state.numericBlockNumber), label: 'Curve oracle quote coin' }
      ],
      metadata: conversion,
      evaluate([input]) {
        const liquidityUsd = scaledRaw(quoteBalanceRaw, quoteDecimals) * input.priceUsd
        if (liquidityUsd < MIN_QUOTE_LIQUIDITY_USD) {
          throw new InvalidPricingError(
            `Curve oracle pool ${pool} holds $${Math.round(liquidityUsd)} of the quote coin, below $${MIN_QUOTE_LIQUIDITY_USD}`
          )
        }
        return {
          priceUsd: tokenInQuote * input.priceUsd,
          blockNumber: state.numericBlockNumber,
          inputs: [recursiveInput(input, conversion)],
          metadata: { ...conversion, liquidityUsd }
        }
      }
    }
  })
}
