import type { Address } from 'viem'

export interface ChainlinkFeed {
  address: Address
  symbol: string
}

const ETH_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

function feed(address: string, symbol: string): ChainlinkFeed {
  return { address: address as Address, symbol }
}

function entries(values: Record<string, [address: string, symbol: string]>): Readonly<Record<string, ChainlinkFeed>> {
  return Object.fromEntries(Object.entries(values).map(([token, [address, symbol]]) => [token, feed(address, symbol)]))
}

const CHAINLINK_FEED_CONFIG: Readonly<Record<number, Readonly<Record<string, ChainlinkFeed>>>> = {
  1: entries({
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ['0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 'ETH'],
    [ETH_NATIVE]: ['0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 'ETH'],
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': ['0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', 'BTC'],
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': ['0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', 'USDC'],
    '0xdac17f958d2ee523a2206206994597c13d831ec7': ['0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', 'USDT'],
    '0x6b175474e89094c44da98b954eedeac495271d0f': ['0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', 'DAI']
  }),
  10: entries({
    '0x4200000000000000000000000000000000000006': ['0x13e3Ee699D1909E989722E753853AE30b17e08c5', 'ETH'],
    '0x68f180fcce6836688e9084f035309e29bf0a2095': ['0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593', 'BTC'],
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': ['0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3', 'USDC'],
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': ['0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3', 'USDC'],
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': ['0xECef79E109e997bCA29c1c0897ec9d7b03647F5E', 'USDT'],
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': ['0x8dBa75e83DA73cc766A7e5a0ee71F656BAb470d6', 'DAI']
  }),
  100: entries({
    '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d': ['0x678df3415fc31947dA4324eC63212874be5a82f8', 'DAI'],
    '0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1': ['0xa767f745331D267c7751297D982b050c93985627', 'ETH'],
    '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83': ['0x26C31ac71010aF62E6B486D1132E266D6298857D', 'USDC'],
    '0x4ecaba5870353805a9f068101a40e0f32ed605c6': ['0x68811D7DF835B1c33e6EEae8E7C141eF48d48cc7', 'USDT'],
    '0x44fa8e6f47987339850636f88629646662444217': ['0x678df3415fc31947dA4324eC63212874be5a82f8', 'DAI']
  }),
  137: entries({
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': ['0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', 'MATIC'],
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': ['0xc907E116054Ad103354f2D350FD2514433D57F6f', 'BTC'],
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': ['0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7', 'USDC'],
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': ['0x0A6513e40db6EB1b165753AD52E80663aeA50545', 'USDT'],
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': ['0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D', 'DAI']
  }),
  146: entries({
    '0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38': ['0xc76dFb89fF298145b417d221B2c747d84952e01d', 'S'],
    '0x50c42deacd8fc9773493ed674b675be577f2634b': ['0x824364077993847f71293B24ccA8567c00c2de11', 'ETH'],
    '0x29219dd400f2bf60e5a23d13be72b486d4038894': ['0x55bCa887199d5520B3Ce285D41e6dC10C08716C9', 'USDC'],
    '0x6047828dc181963ba44974801ff68e538da5eaf9': ['0x76F4C040A792aFB7F6dBadC7e30ca3EEa140D216', 'USDT'],
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c': ['0x8Bcd59Cb7eEEea8e2Da3080C891609483dae53EF', 'BTC']
  }),
  250: entries({}),
  8453: entries({
    '0x4200000000000000000000000000000000000006': ['0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', 'ETH'],
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c': ['0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E', 'BTC'],
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': ['0x458138Fc0D67027E9A6778ef40a6ffC318c69061', 'USDC'],
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': ['0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9', 'USDT'],
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': ['0x591e79239a7d679378eC8c847e5038150364C78F', 'DAI']
  }),
  42161: entries({
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': ['0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', 'ETH'],
    '0x2f2a2543b76a4166549f7aaabf8a7d7b4b0f4f5f': ['0x6ce185860a4963106506C203335A2910413708e9', 'BTC'],
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': ['0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', 'USDC'],
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': ['0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', 'USDC'],
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': ['0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', 'USDT'],
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': ['0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB', 'DAI']
  }),
  80094: entries({}),
  747474: entries({
    '0x4200000000000000000000000000000000000006': ['0xc62782910529ee50eFDa9a0273B20d8bD1C1e4b2', 'KAT'],
    '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62': ['0x7BdBDB772f4a073BadD676A567C6ED82049a8eEE', 'ETH'],
    '0x0913da6da4b42f538b445599b46bb4622342cf52': ['0x0D03E26E0B5D09E24E5a45696D0FcA12E9648FBB', 'BTC'],
    '0x203a662b0bd271a6ed5a60edfbd04bfce608fd36': ['0xbe5CE90e16B9d9d988D64b0E1f6ed46EbAfb9606', 'USDC'],
    '0x2dca96907fde857dd3d816880a0df407eeb2d2f2': ['0xF03E1566Fc6B0eBFA3dD3aA197759C4c6617ec78', 'USDT']
  })
}

export const CHAINLINK_FEEDS: Readonly<Record<number, Readonly<Record<string, Address>>>> = Object.fromEntries(
  Object.entries(CHAINLINK_FEED_CONFIG).map(([chainId, feeds]) => [
    chainId,
    Object.fromEntries(Object.entries(feeds).map(([token, value]) => [token, value.address]))
  ])
)

export function getChainlinkFeed(chainId: number, token: string): ChainlinkFeed | null {
  const normalizedToken = token.toLowerCase()
  const address = CHAINLINK_FEEDS[chainId]?.[normalizedToken]
  if (!address) {
    return null
  }
  return { address, symbol: CHAINLINK_FEED_CONFIG[chainId]?.[normalizedToken]?.symbol ?? '' }
}

export function hasChainlinkFeeds(chainId: number): boolean {
  return Object.keys(CHAINLINK_FEEDS[chainId] ?? {}).length > 0
}
