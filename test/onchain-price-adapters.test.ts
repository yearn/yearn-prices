import type { PublicClient } from 'viem'
import { describe, expect, test } from 'vitest'
import { createOnchainPriceAdapters } from '../src/onchain-price-adapters'
import { RecursivePriceEngine, type ResolvedPricePath } from '../src/recursive-pricing'

const WRAPPER = '0x0000000000000000000000000000000000000001'
const UNDERLYING = '0x0000000000000000000000000000000000000002'
const SECOND_UNDERLYING = '0x0000000000000000000000000000000000000003'
const POOL = '0x0000000000000000000000000000000000000004'
const SY = '0x0000000000000000000000000000000000000005'
const PT = '0x0000000000000000000000000000000000000006'
const YT = '0x0000000000000000000000000000000000000007'
const FBEETS = '0xfcef8a994209d6916eb2c86cdd2afd60aa6f54b1'
const YFI = '0x0bc529c00c6401aeF6D220BE8C6Ea1667F6Ad93e'
const UPYFI = '0x95710BDE45C8D384A976Cc58Cc7a7e489576b098'
const SUPYFI = '0xCb7DCe63aBE175cA354Dcca9cc10554D255777Ee'
const COVEYFI = '0xff71841eefca78a64421db28060855036765c248'
const YIP88_REDEMPTION = '0xba18d0df75a3ff58ef40a8fc0d3e4db74a0e681d'
const YNETH = '0x09db87a538bd693e9d08544577d5ccfaa6373a48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const RGUSD = '0x78da5799cf427fee11e9996982f4150ece7a99a7'
const RESERVE_MAIN = '0xB436Cc2C93f6B146830778e93F4c65D9f2f253B2'
const RESERVE_BASKET_HANDLER = '0x82B34a2a9b2BEB28b819960cf9AB99668Cef5fc3'
const SDAI = '0x83F20F44975D03b1b09e64809B757c47f942BEeA'
const REQUESTED_TIMESTAMP = 1_700_006_399
const BLOCK_NUMBER = 19_000_000

function marketPath(
  token: string,
  priceUsd = 2,
  overrides: Partial<ResolvedPricePath> = {},
): ResolvedPricePath {
  return {
    chain: 'ethereum',
    token,
    requestedTimestamp: REQUESTED_TIMESTAMP,
    observedTimestamp: REQUESTED_TIMESTAMP - 60,
    priceUsd,
    symbol: 'TEST',
    confidence: 0.99,
    source: 'defillama',
    adapter: 'defillama-historical',
    classification: 'observed',
    quality: 'near-eod',
    blockNumber: null,
    inputs: [],
    metadata: {},
    ...overrides,
  }
}

function engineFor(client: PublicClient) {
  return new RecursivePriceEngine(
    async target => {
      if (target.token.toLowerCase() !== UNDERLYING.toLowerCase()) return null
      expect(target.blockNumber).toBe(BLOCK_NUMBER)
      return marketPath(target.token)
    },
    createOnchainPriceAdapters({
      clientForChain: () => client,
      blockForTarget: async () => BigInt(BLOCK_NUMBER),
    }),
  )
}

function target() {
  return {
    chain: 'ethereum',
    token: WRAPPER,
    requestedTimestamp: REQUESTED_TIMESTAMP,
    blockNumber: null,
  }
}

function poolEngine(
  client: PublicClient,
  prices: Record<string, number>,
) {
  return new RecursivePriceEngine(
    async priceTarget => {
      const priceUsd = prices[priceTarget.token.toLowerCase()]
      return priceUsd == null ? null : marketPath(priceTarget.token, priceUsd)
    },
    createOnchainPriceAdapters({
      clientForChain: () => client,
      blockForTarget: async () => BigInt(BLOCK_NUMBER),
    }),
  )
}

describe('wrapper and lending price adapters', () => {
  test.each([
    { token: UPYFI, index: 1n, facilityToken: SUPYFI, scale: 69_420n },
    { token: COVEYFI, index: 2n, facilityToken: COVEYFI, scale: 1n },
  ])('prices $token from its exact YIP-88 net redemption value', async ({ token, index, facilityToken, scale }) => {
    const feeRaw = 88_461_538_461_538_461n
    const oneTokenRaw = 10n ** 18n
    const grossYfiRaw = oneTokenRaw / scale
    const netYfiRaw = grossYfiRaw * (10n ** 18n - feeRaw) / 10n ** 18n
    const client = {
      async readContract(request: { address: string; functionName: string; args?: readonly unknown[]; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        const address = request.address.toLowerCase()
        if (address === YIP88_REDEMPTION) {
          if (request.functionName === 'yfi') return YFI
          if (request.functionName === 'fee') return feeRaw
          expect(request.args?.[0]).toBe(index)
          if (request.functionName === 'tokens') return facilityToken
          if (request.functionName === 'scales') return scale
          if (request.functionName === 'capacities') return 100n * oneTokenRaw
          if (request.functionName === 'enabled') return true
          if (request.functionName === 'used') return 0n
        }
        if (address === SUPYFI.toLowerCase()) {
          if (request.functionName === 'asset') return UPYFI
          if (request.functionName === 'maxDeposit') return 2n ** 256n - 1n
          if (request.functionName === 'convertToShares') return oneTokenRaw
        }
        if (request.functionName === 'decimals') return 18
        if (address === YFI.toLowerCase() && request.functionName === 'balanceOf') return 50n * oneTokenRaw
        throw new Error(`method unavailable: ${request.functionName}`)
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === YFI.toLowerCase()
        ? marketPath(priceTarget.token, 2_000)
        : null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'ethereum',
      token,
      requestedTimestamp: REQUESTED_TIMESTAMP,
      blockNumber: null,
    })

    expect(result.failure).toBeNull()
    expect(result.path?.adapter).toBe('yip88-liquid-locker-redemption')
    expect(result.path?.priceUsd).toBeCloseTo(Number(netYfiRaw) / 1e18 * 2_000, 12)
    expect(result.path).toMatchObject({
      metadata: {
        method: 'yip88-net-redemption',
        valuationRule: 'enabled-capacity-and-liquidity-checked-net-redemption',
        index: index.toString(),
        scaleRaw: scale.toString(),
        feeRaw: feeRaw.toString(),
        grossYfiRaw: grossYfiRaw.toString(),
        netYfiRaw: netYfiRaw.toString(),
      },
      inputs: [{
        conversion: { method: 'yip88-net-redemption' },
      }],
    })
    expect(result.path?.inputs[0].token.toLowerCase()).toBe(YFI.toLowerCase())
    if (token === UPYFI) {
      expect(result.path?.metadata.wrapper).toMatchObject({
        address: SUPYFI,
        asset: UPYFI,
        convertedSharesRaw: oneTokenRaw.toString(),
      })
    }
  })

  test('does not use nominal locker parity when the YIP-88 facility is disabled', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.address.toLowerCase() === YIP88_REDEMPTION) {
          if (request.functionName === 'yfi') return YFI
          if (request.functionName === 'fee') return 88_461_538_461_538_461n
          if (request.functionName === 'tokens') return COVEYFI
          if (request.functionName === 'scales') return 1n
          if (request.functionName === 'capacities') return 100n * 10n ** 18n
          if (request.functionName === 'enabled') return false
          if (request.functionName === 'used') return 0n
        }
        if (request.functionName === 'decimals') return 18
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === YFI.toLowerCase()
        ? marketPath(priceTarget.token, 2_000)
        : null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'ethereum',
      token: COVEYFI,
      requestedTimestamp: REQUESTED_TIMESTAMP,
      blockNumber: null,
    })

    expect(result).toMatchObject({ path: null, failure: { reason: 'unsupported' } })
  })

  test('prices allow-listed native shares from their exact historical conversion', async () => {
    const convertedAssetsRaw = 1_080_340_686_311_753_659n
    const client = {
      async readContract(request: { address: string; functionName: string; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        if (request.address.toLowerCase() === YNETH && request.functionName === 'decimals') return 18
        if (request.address.toLowerCase() === YNETH && request.functionName === 'convertToAssets') {
          return convertedAssetsRaw
        }
        throw new Error(`method unavailable: ${request.functionName}`)
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === WETH
        ? marketPath(priceTarget.token, 2_000)
        : null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'ethereum', token: YNETH, requestedTimestamp: REQUESTED_TIMESTAMP, blockNumber: null,
    })

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'native-share-convert-to-assets',
        priceUsd: Number(convertedAssetsRaw) / 1e18 * 2_000,
        metadata: {
          method: 'convertToAssets',
          underlying: WETH,
          convertedAssetsRaw: convertedAssetsRaw.toString(),
          valuationRule: 'allowlisted-native-share-conversion',
        },
        inputs: [{ conversion: { method: 'convertToAssets' } }],
      },
    })
    expect(result.path?.inputs[0].token.toLowerCase()).toBe(WETH)
  })

  test('prices allow-listed Reserve RTokens only from a complete collateralized redemption basket', async () => {
    const oneTokenRaw = 10n ** 18n
    const constituentAmountRaw = 849_362_755_145_849_213n
    const client = {
      async readContract(request: { address: string; functionName: string; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        const address = request.address.toLowerCase()
        if (address === RGUSD) {
          if (request.functionName === 'main') return RESERVE_MAIN
          if (request.functionName === 'decimals') return 18
          if (request.functionName === 'totalSupply') return 10_000n * oneTokenRaw
          if (request.functionName === 'basketsNeeded') return 10_000n * oneTokenRaw
          if (request.functionName === 'redemptionAvailable') return 10_000n * oneTokenRaw
        }
        if (address === RESERVE_MAIN.toLowerCase()) {
          if (request.functionName === 'basketHandler') return RESERVE_BASKET_HANDLER
          if (request.functionName === 'frozen') return false
        }
        if (address === RESERVE_BASKET_HANDLER.toLowerCase()) {
          if (request.functionName === 'fullyCollateralized') return true
          if (request.functionName === 'quote') return [[SDAI], [constituentAmountRaw]] as const
        }
        if (address === SDAI.toLowerCase() && request.functionName === 'decimals') return 18
        throw new Error(`method unavailable: ${request.functionName}`)
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => priceTarget.token.toLowerCase() === SDAI.toLowerCase()
        ? marketPath(priceTarget.token, 1.2)
        : null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'ethereum', token: RGUSD, requestedTimestamp: REQUESTED_TIMESTAMP, blockNumber: null,
    })

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'reserve-rtoken-redemption',
        priceUsd: Number(constituentAmountRaw) / 1e18 * 1.2,
        metadata: {
          method: 'reserve-rtoken-basket-redemption',
          valuationRule: 'fully-collateralized-complete-redemption-basket',
          redemptionAvailableRaw: (10_000n * oneTokenRaw).toString(),
          constituents: [{ address: SDAI, amountRaw: constituentAmountRaw.toString() }],
        },
        inputs: [{ token: SDAI }],
      },
    })

    const incomplete = await new RecursivePriceEngine(
      async () => null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    ).resolve({
      chain: 'ethereum', token: RGUSD, requestedTimestamp: REQUESTED_TIMESTAMP, blockNumber: null,
    })
    expect(incomplete).toMatchObject({ path: null, failure: { reason: 'unsupported' } })
    expect(incomplete.failure?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: 'reserve-rtoken-redemption' }),
    ]))
  })

  test('does not price a Reserve RToken when its redemption basket is not fully collateralized', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        const address = request.address.toLowerCase()
        if (address === RGUSD) {
          if (request.functionName === 'main') return RESERVE_MAIN
          if (request.functionName === 'decimals') return 18
          if (request.functionName === 'totalSupply') return 10_000n * 10n ** 18n
          if (request.functionName === 'basketsNeeded') return 10_000n * 10n ** 18n
          if (request.functionName === 'redemptionAvailable') return 10_000n * 10n ** 18n
        }
        if (address === RESERVE_MAIN.toLowerCase()) {
          if (request.functionName === 'basketHandler') return RESERVE_BASKET_HANDLER
          if (request.functionName === 'frozen') return false
        }
        if (address === RESERVE_BASKET_HANDLER.toLowerCase() && request.functionName === 'fullyCollateralized') {
          return false
        }
        throw new Error(`method unavailable: ${request.functionName}`)
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async () => null,
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'ethereum', token: RGUSD, requestedTimestamp: REQUESTED_TIMESTAMP, blockNumber: null,
    })

    expect(result).toMatchObject({ path: null, failure: { reason: 'unsupported' } })
  })

  test('prices allow-listed Fantom fBEETS from its historical pro-rata BPT balance', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        if (request.address.toLowerCase() === FBEETS && request.functionName === 'vestingToken') {
          return UNDERLYING
        }
        if (request.functionName === 'decimals') return 18
        if (request.address.toLowerCase() === FBEETS && request.functionName === 'totalSupply') {
          return 100n * 10n ** 18n
        }
        if (request.address.toLowerCase() === UNDERLYING && request.functionName === 'balanceOf') {
          return 120n * 10n ** 18n
        }
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => (
        priceTarget.token.toLowerCase() === UNDERLYING
          ? marketPath(priceTarget.token, 10, {
              chain: 'fantom',
              quality: 'fallback',
              classification: 'estimated',
            })
          : null
      ),
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    const result = await engine.resolve({
      chain: 'fantom',
      token: FBEETS,
      requestedTimestamp: REQUESTED_TIMESTAMP,
      blockNumber: null,
    })

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'beets-bar-share-rate',
        priceUsd: 12,
        quality: 'fallback',
        metadata: {
          method: 'beets-bar-pro-rata-underlying',
          underlying: UNDERLYING,
          totalSupplyRaw: (100n * 10n ** 18n).toString(),
          underlyingBalanceRaw: (120n * 10n ** 18n).toString(),
        },
        inputs: [{
          classification: 'estimated',
          quality: 'fallback',
          conversion: { valuationRule: 'all-underlying-bpt-constituents-required' },
        }],
      },
    })

  })

  test('prices ERC-4626 shares with exact historical conversion provenance', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        if (request.functionName === 'asset') return UNDERLYING
        if (request.functionName === 'decimals') {
          return request.address.toLowerCase() === WRAPPER.toLowerCase() ? 18 : 6
        }
        if (request.functionName === 'convertToAssets') return 1_500_000n
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'erc4626-convert-to-assets',
        priceUsd: 3,
        blockNumber: BLOCK_NUMBER,
        quality: 'near-eod',
        metadata: {
          historicalBlock: {
            number: BLOCK_NUMBER,
            timestamp: REQUESTED_TIMESTAMP,
            requestedTimestamp: REQUESTED_TIMESTAMP,
            distanceSeconds: 0,
          },
        },
        inputs: [{
          adapter: 'defillama-historical',
          conversion: {
            method: 'convertToAssets',
            convertedAssetsRaw: '1500000',
            underlyingDecimals: 6,
            historicalBlock: { number: BLOCK_NUMBER, distanceSeconds: 0 },
          },
        }],
      },
    })
  })

  test('uses ERC-4626 previewRedeem when convertToAssets is unavailable', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string; blockNumber: bigint }) {
        expect(request.blockNumber).toBe(BigInt(BLOCK_NUMBER))
        if (request.functionName === 'asset') return UNDERLYING
        if (request.functionName === 'decimals') {
          return request.address.toLowerCase() === WRAPPER.toLowerCase() ? 18 : 6
        }
        if (request.functionName === 'convertToAssets') throw new Error('method unavailable')
        if (request.functionName === 'previewRedeem') return 1_250_000n
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'erc4626-convert-to-assets',
        priceUsd: 2.5,
        inputs: [{ conversion: { method: 'previewRedeem', convertedAssetsRaw: '1250000' } }],
      },
    })
  })

  test('leaves ERC-4626 shares unavailable when neither standard conversion is readable', async () => {
    const client = {
      async readContract(request: { functionName: string }) {
        if (request.functionName === 'asset') return UNDERLYING
        if (request.functionName === 'decimals') return 18
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({ path: null, failure: { reason: 'unsupported' } })
  })

  test('falls through ERC-4626 and prices a Yearn share rate', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.address.toLowerCase() === WRAPPER.toLowerCase()) {
          if (request.functionName === 'asset') throw new Error('method unavailable')
          if (request.functionName === 'token') return UNDERLYING
          if (request.functionName === 'pricePerShare') return 1_250_000n
          if (request.functionName === 'decimals') return 18
        }
        if (request.functionName === 'decimals') return 6
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'yearn-share-rate',
        priceUsd: 2.5,
        inputs: [{ conversion: { method: 'pricePerShare', rateDecimals: 6 } }],
      },
    })
  })

  test('prices Compound and Iron Bank shares from exchangeRateStored', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.address.toLowerCase() === WRAPPER.toLowerCase()) {
          if (['asset', 'token', 'underlying'].includes(request.functionName)) {
            if (request.functionName === 'underlying') return UNDERLYING
            throw new Error('method unavailable')
          }
          if (request.functionName === 'exchangeRateStored') return 2n * 10n ** 14n
          if (request.functionName === 'decimals') return 8
        }
        if (request.functionName === 'decimals') return 6
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'compound-exchange-rate',
        priceUsd: 0.04,
        inputs: [{ conversion: { method: 'exchangeRateStored' } }],
      },
    })
  })

  test('prices Aave receipt tokens at underlying parity', async () => {
    const client = {
      async readContract(request: { functionName: string }) {
        if (request.functionName === 'UNDERLYING_ASSET_ADDRESS') return UNDERLYING
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'aave-underlying-parity',
        priceUsd: 2,
        inputs: [{ conversion: { method: 'one-to-one' } }],
      },
    })
  })

  test('prices wstETH from its historical stETH conversion', async () => {
    const client = {
      async readContract(request: { functionName: string }) {
        if (request.functionName === 'stETH') return UNDERLYING
        if (request.functionName === 'stEthPerToken') return 1_100_000_000_000_000_000n
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await engineFor(client).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'wsteth-rate',
        priceUsd: 2.2,
        inputs: [{ conversion: { method: 'stEthPerToken' } }],
      },
    })
  })

  test('keeps missing RPC configuration retryable instead of terminalizing the asset', async () => {
    const engine = new RecursivePriceEngine(
      async () => null,
      createOnchainPriceAdapters({ clientForChain: () => null }),
    )

    const result = await engine.resolve(target())

    expect(result).toMatchObject({ path: null, failure: { reason: 'retryable' } })
    expect(result.failure?.attempts[0]).toMatchObject({
      adapter: 'erc4626-convert-to-assets',
      reason: 'retryable',
      error: 'RPC_URL_1 is not configured; on-chain pricing is temporarily unavailable',
    })
    expect(result.failure?.attempts).toHaveLength(9)
  })
})

describe('pool and LP price adapters', () => {
  test('requires and prices both AMM reserves for complete pool NAV', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.address.toLowerCase() !== WRAPPER.toLowerCase()) {
          if (request.functionName === 'decimals') {
            return request.address.toLowerCase() === UNDERLYING.toLowerCase() ? 6 : 18
          }
          throw new Error('method unavailable')
        }
        if (request.functionName === 'token0') return UNDERLYING
        if (request.functionName === 'token1') return SECOND_UNDERLYING
        if (request.functionName === 'getReserves') return [100n * 10n ** 6n, 10n * 10n ** 18n, 0] as const
        if (request.functionName === 'totalSupply') return 10n * 10n ** 18n
        if (request.functionName === 'decimals') return 18
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient
    const engine = poolEngine(client, {
      [UNDERLYING.toLowerCase()]: 1,
      [SECOND_UNDERLYING.toLowerCase()]: 2_000,
    })

    const result = await engine.resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'amm-reserve-nav',
        priceUsd: 2_010,
        metadata: { valuationRule: 'all-constituents-required' },
        inputs: [
          { token: UNDERLYING, conversion: { method: 'pool-reserve-nav' } },
          { token: SECOND_UNDERLYING, conversion: { method: 'pool-reserve-nav' } },
        ],
      },
    })

    const incomplete = await poolEngine(client, {
      [UNDERLYING.toLowerCase()]: 1,
    }).resolve(target())
    expect(incomplete).toMatchObject({ path: null, failure: { reason: 'invalid' } })
    expect(incomplete.failure?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter: 'amm-reserve-nav',
        error: `AMM reserve NAV requires every constituent price: ${JSON.stringify([
          { address: SECOND_UNDERLYING, failureClass: 'unsupported' },
        ])}`,
      }),
    ]))

    const unavailable = await poolEngine(client, {}).resolve(target())
    expect(unavailable.failure?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter: 'amm-reserve-nav',
        error: `AMM reserve NAV requires every constituent price: ${JSON.stringify([
          { address: UNDERLYING, failureClass: 'unsupported' },
          { address: SECOND_UNDERLYING, failureClass: 'unsupported' },
        ])}`,
      }),
    ]))
  })

  test('does not substitute reserve ratios for transient constituent failures', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.address.toLowerCase() !== WRAPPER.toLowerCase()) {
          if (request.functionName === 'decimals') return 18
          throw new Error('method unavailable')
        }
        if (request.functionName === 'token0') return UNDERLYING
        if (request.functionName === 'token1') return SECOND_UNDERLYING
        if (request.functionName === 'getReserves') {
          return [1_000n * 10n ** 18n, 20n * 10n ** 18n, 0] as const
        }
        if (request.functionName === 'totalSupply') return 100n * 10n ** 18n
        if (request.functionName === 'decimals') return 18
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient
    const engine = new RecursivePriceEngine(
      async priceTarget => {
        if (priceTarget.token.toLowerCase() === UNDERLYING.toLowerCase()) {
          throw new Error('HTTP request failed with status 503')
        }
        return priceTarget.token.toLowerCase() === SECOND_UNDERLYING.toLowerCase()
          ? marketPath(priceTarget.token, 2_000)
          : null
      },
      createOnchainPriceAdapters({
        clientForChain: () => client,
        blockForTarget: async () => BigInt(BLOCK_NUMBER),
      }),
    )

    await expect(engine.resolve(target())).resolves.toMatchObject({
      path: null,
      failure: { reason: 'retryable' },
    })
  })

  test('prices Balancer NAV and removes preminted self-BPT from supply', async () => {
    const poolId = `0x${'1'.repeat(64)}`
    const client = {
      async readContract(request: { address: string; functionName: string }) {
        if (request.functionName === 'getPoolId') return poolId
        if (request.functionName === 'getPoolTokens') {
          return [
            [WRAPPER, UNDERLYING, SECOND_UNDERLYING],
            [40n * 10n ** 18n, 100n * 10n ** 6n, 10n * 10n ** 18n],
            18_999_999n,
          ] as const
        }
        if (request.functionName === 'totalSupply') return 100n * 10n ** 18n
        if (request.functionName === 'decimals') {
          return request.address.toLowerCase() === UNDERLYING.toLowerCase() ? 6 : 18
        }
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await poolEngine(client, {
      [UNDERLYING.toLowerCase()]: 1,
      [SECOND_UNDERLYING.toLowerCase()]: 2_000,
    }).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'balancer-v2-vault-nav',
        priceUsd: 335,
        metadata: {
          excludedPremintedPoolTokensRaw: (40n * 10n ** 18n).toString(),
          valuationRule: 'all-constituents-required',
        },
      },
    })
  })

  test('prices Pendle LPs through the historical LP-to-asset rate', async () => {
    const client = {
      async readContract(request: { functionName: string }) {
        if (request.functionName === 'readTokens') return [SY, PT, YT] as const
        if (request.functionName === 'assetInfo') return [0, UNDERLYING, 6] as const
        if (request.functionName === 'getLpToAssetRate') return 1_200_000_000_000_000_000n
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const result = await poolEngine(client, { [UNDERLYING.toLowerCase()]: 1 }).resolve(target())

    expect(result).toMatchObject({
      failure: null,
      path: {
        adapter: 'pendle-oracle-lp-to-asset',
        priceUsd: 1.2,
        metadata: {
          method: 'getLpToAssetRate',
          asset: UNDERLYING,
          assetDecimals: 6,
          rateDecimals: 18,
          twapSeconds: 900,
        },
      },
    })
  })

  test('prices Curve LPs only when every reserve constituent is available', async () => {
    const client = {
      async readContract(request: { address: string; functionName: string; args?: readonly bigint[] }) {
        if (request.address.toLowerCase() === WRAPPER.toLowerCase() && request.functionName === 'minter') return POOL
        if (request.address.toLowerCase() === POOL.toLowerCase() && request.functionName === 'coins') {
          if (request.args?.[0] === 0n) return UNDERLYING
          if (request.args?.[0] === 1n) return SECOND_UNDERLYING
          throw new Error('coin index unavailable')
        }
        if (request.address.toLowerCase() === POOL.toLowerCase() && request.functionName === 'balances') {
          if (request.args?.[0] === 0n) return 100n * 10n ** 6n
          if (request.args?.[0] === 1n) return 10n * 10n ** 18n
        }
        if (request.address.toLowerCase() === WRAPPER.toLowerCase() && request.functionName === 'totalSupply') {
          return 10n * 10n ** 18n
        }
        if (request.functionName === 'decimals') {
          return request.address.toLowerCase() === UNDERLYING.toLowerCase() ? 6 : 18
        }
        throw new Error('method unavailable')
      },
    } as unknown as PublicClient

    const complete = await poolEngine(client, {
      [UNDERLYING.toLowerCase()]: 1,
      [SECOND_UNDERLYING.toLowerCase()]: 2_000,
    }).resolve(target())
    expect(complete).toMatchObject({
      failure: null,
      path: {
        adapter: 'curve-reserve-nav',
        priceUsd: 2_010,
        metadata: { valuationRule: 'all-constituents-required', poolAddress: POOL },
      },
    })

    const incomplete = await poolEngine(client, {
      [UNDERLYING.toLowerCase()]: 1,
    }).resolve(target())
    expect(incomplete).toMatchObject({ path: null, failure: { reason: 'unsupported' } })
  })

  test('validates the explicit Pendle TWAP window', () => {
    expect(() => createOnchainPriceAdapters({
      clientForChain: () => null,
      pendleTwapSeconds: 0,
    })).toThrow('Pendle TWAP seconds must fit uint32 and be positive')
  })
})
