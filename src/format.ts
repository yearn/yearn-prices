export function toResponseNumber(value: string | number): number {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number(value.toFixed(18))
  }

  const trimmed = value.trim()
  if (!trimmed.includes('.')) {
    return Number(trimmed)
  }

  const negative = trimmed.startsWith('-')
  const digits = negative ? trimmed.slice(1) : trimmed
  const [whole, fraction = ''] = digits.split('.')
  const limitedFraction = fraction.slice(0, 18).replace(/0+$/, '')
  const normalized = limitedFraction.length > 0 ? `${whole}.${limitedFraction}` : whole
  return Number(negative ? `-${normalized}` : normalized)
}

export function optionalResponseNumber(value: string | number | null): number | null {
  if (value === null) {
    return null
  }

  return toResponseNumber(value)
}

// DeFiLlama's confidence is a 0-1 quality score, but it occasionally comes back
// marginally above 1 (e.g. 1.01). Clamp to [0, 1] so stored values stay in range.
export function capConfidence(value: number | null | undefined): number | null {
  return value == null ? null : Math.max(0, Math.min(value, 1))
}

// Sanity ceiling on a single token's USD price. No real token/vault share trades
// above this; DefiLlama returns 0 for some legacy Curve LPs and ~1e10 for its
// stale Curve-LP bug — both garbage. Guard at ingestion so they never enter the
// table and outrank the Curve fallback.
// ponytail: absolute cap (tune if a legit token ever exceeds it); upgrade path is
// a per-token expected-range check.
export const MAX_PLAUSIBLE_PRICE = 1_000_000

// Curve LP price = on-chain virtual_price × coin0's USD price (from DefiLlama),
// exact only for stableswap pools. Shipped at full confidence so it ranks as a
// trusted fallback; the residual uncertainty is coin0's price, not the LP math.
export const CURVE_CONFIDENCE = 1

// A served USD price is only valid in (0, MAX]: anything else is provider garbage.
export function isPlausiblePrice(price: number): boolean {
  return Number.isFinite(price) && price > 0 && price <= MAX_PLAUSIBLE_PRICE
}
