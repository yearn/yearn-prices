import { InvalidPricingError } from './errors'

export function scaledRaw(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new InvalidPricingError('Token decimals must be an integer between 0 and 255')
  }
  const value = Number(raw) / 10 ** decimals
  if (!Number.isFinite(value)) {
    throw new InvalidPricingError('Token amount exceeds numeric pricing range')
  }
  return value
}

export function calculateWrapperPrice(
  convertedAssetsRaw: bigint,
  underlyingDecimals: number,
  oneShareRaw: bigint,
  shareDecimals: number,
  underlyingPrice: number,
): number {
  const shares = scaledRaw(oneShareRaw, shareDecimals)
  if (shares <= 0) {
    throw new InvalidPricingError('Wrapper share amount must be positive')
  }
  const price = (scaledRaw(convertedAssetsRaw, underlyingDecimals) / shares) * underlyingPrice
  if (!Number.isFinite(price) || price <= 0) {
    throw new InvalidPricingError('Wrapper produced an invalid price')
  }
  return price
}

export function calculateCompoundTokenPrice(
  exchangeRateRaw: bigint,
  tokenDecimals: number,
  underlyingDecimals: number,
  underlyingPrice: number,
): number {
  const exponent = 18 + underlyingDecimals - tokenDecimals
  if (exponent < 0 || exponent > 255) {
    throw new InvalidPricingError('Compound exchange-rate scale is invalid')
  }
  const price = (Number(exchangeRateRaw) / 10 ** exponent) * underlyingPrice
  if (!Number.isFinite(price) || price <= 0) {
    throw new InvalidPricingError('Compound produced an invalid price')
  }
  return price
}

export interface PoolNavInput {
  address: string
  balanceRaw: bigint
  decimals: number
  priceUsd: number
}

export function calculatePoolNavPrice(
  assets: PoolNavInput[],
  totalSupplyRaw: bigint,
  poolDecimals: number,
  excludedPoolBalanceRaw = 0n,
): number {
  const circulatingSupply = scaledRaw(totalSupplyRaw - excludedPoolBalanceRaw, poolDecimals)
  if (circulatingSupply <= 0) {
    throw new InvalidPricingError('Pool token has no circulating supply')
  }
  if (assets.length === 0) {
    throw new InvalidPricingError('Pool has no priced constituents')
  }
  let nav = 0
  for (const asset of assets) {
    if (!Number.isFinite(asset.priceUsd) || asset.priceUsd <= 0) {
      throw new InvalidPricingError(`Invalid price for pool constituent ${asset.address}`)
    }
    nav += scaledRaw(asset.balanceRaw, asset.decimals) * asset.priceUsd
  }
  const price = nav / circulatingSupply
  if (!Number.isFinite(price) || price <= 0) {
    throw new InvalidPricingError('Pool NAV produced an invalid price')
  }
  return price
}
