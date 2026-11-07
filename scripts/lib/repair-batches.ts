import type { RepairTarget } from '../../src/db/repair-queue'

/** Keep one chain/day together so roots share pinned blocks and dependency frontiers.
 * Newest days run first; root count is independent of RPC concurrency. */
export function repairGraphBatches(targets: RepairTarget[], size = 50): RepairTarget[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('Invalid graph batch size')
  const sorted = [...targets].sort(
    (a, b) =>
      b.timestamp - a.timestamp || a.chainId - b.chainId || a.token.toLowerCase().localeCompare(b.token.toLowerCase())
  )
  const batches: RepairTarget[][] = []
  for (const target of sorted) {
    const last = batches[batches.length - 1]
    if (!last || last.length >= size || last[0].chainId !== target.chainId || last[0].timestamp !== target.timestamp)
      batches.push([target])
    else last.push(target)
  }
  return batches
}
