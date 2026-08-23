import { isTodayNormalized } from '../../utils/time'

export interface RatioRow {
  timestamp: number
  ratio: number
}

export function computeRepairRatios(
  writes: Array<{ timestamp: number; price: number | string }>,
  storedPrices: Map<number, number>
): RatioRow[] {
  const rows: RatioRow[] = []
  for (const write of writes) {
    if (isTodayNormalized(write.timestamp)) {
      continue
    }
    const oldPrice = storedPrices.get(write.timestamp)
    const newPrice = Number(write.price)
    if (!oldPrice || !Number.isFinite(newPrice) || oldPrice === newPrice) {
      continue
    }
    rows.push({ timestamp: write.timestamp, ratio: newPrice / oldPrice })
  }
  return rows
}
