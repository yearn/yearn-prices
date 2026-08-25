const DAY_SECONDS = 86_400

export interface ContiguousRange<Item> {
  identifier: string
  rangeStart: number
  rangeEnd: number
  items: Item[]
}

export function rangeSpanDays(range: { rangeStart: number; rangeEnd: number }): number {
  return (range.rangeEnd - range.rangeStart) / DAY_SECONDS + 1
}

export function groupContiguousRanges<Item>(
  items: Item[],
  identifierOf: (item: Item) => string,
  eodOf: (item: Item) => number,
  maximumSpanDays: number
): Array<ContiguousRange<Item>> {
  const byIdentifier = new Map<string, Item[]>()
  for (const item of items) {
    const identifier = identifierOf(item)
    const group = byIdentifier.get(identifier) ?? []
    group.push(item)
    byIdentifier.set(identifier, group)
  }

  const ranges: Array<ContiguousRange<Item>> = []
  for (const [identifier, group] of byIdentifier) {
    const sorted = [...group].sort((left, right) => eodOf(left) - eodOf(right))

    let current: ContiguousRange<Item> | null = null
    for (const item of sorted) {
      const eod = eodOf(item)
      const spanDays = current ? (eod - current.rangeStart) / DAY_SECONDS + 1 : 0

      if (current && eod === current.rangeEnd) {
        current.items.push(item)
        continue
      }

      if (current && eod === current.rangeEnd + DAY_SECONDS && spanDays <= maximumSpanDays) {
        current.rangeEnd = eod
        current.items.push(item)
        continue
      }

      current = { identifier, rangeStart: eod, rangeEnd: eod, items: [item] }
      ranges.push(current)
    }
  }

  return ranges
}
