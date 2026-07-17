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
