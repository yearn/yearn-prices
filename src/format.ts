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
