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

/** Generic ratio x price: `(numerator / denominator) * assetPrice`. */
export function calculateWrapperPrice(
  numeratorRaw: bigint,
  numeratorDecimals: number,
  denominatorRaw: bigint,
  denominatorDecimals: number,
  assetPrice: number
): number {
  const denominator = scaledRaw(denominatorRaw, denominatorDecimals)
  if (denominator <= 0) {
    throw new InvalidPricingError('Wrapper denominator amount must be positive')
  }
  const price = (scaledRaw(numeratorRaw, numeratorDecimals) / denominator) * assetPrice
  if (!Number.isFinite(price) || price <= 0) {
    throw new InvalidPricingError('Wrapper produced an invalid price')
  }
  return price
}

export function calculateCompoundTokenPrice(
  exchangeRateRaw: bigint,
  tokenDecimals: number,
  underlyingDecimals: number,
  underlyingPrice: number
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

/** NAV of `assets` per unit of `denominatorSupplyRaw` (a supply, or a basket). */
export function calculatePoolNavPrice(
  assets: PoolNavInput[],
  denominatorSupplyRaw: bigint,
  denominatorDecimals: number,
  excludedPoolBalanceRaw = 0n
): number {
  const circulatingSupply = scaledRaw(denominatorSupplyRaw - excludedPoolBalanceRaw, denominatorDecimals)
  if (circulatingSupply <= 0) {
    throw new InvalidPricingError('Pool NAV denominator must be positive')
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
