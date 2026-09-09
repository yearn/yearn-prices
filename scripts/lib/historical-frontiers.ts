import type { BatchedHistoricalClient, CoinTarget } from './batched-historical-client'

export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency')
  let cursor = 0
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) await work(items[cursor++])
    })
  )
  // Keep discovery mode active until every worker has stopped, even on error.
  const failure = workers.find((worker) => worker.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

/** Gather a workload-wide dependency frontier before sending provider batches.
 * Each probe uses a fresh recursive engine: provisional failures cannot leak
 * into later rounds. Final resolution is always performed by the caller. */
export async function prefetchHistoricalFrontiers<T>(options: {
  provider: BatchedHistoricalClient
  roots: readonly T[]
  concurrency: number
  maxRounds: number
  probe: (root: T) => Promise<unknown>
  onRound?: (round: number, targets: CoinTarget[]) => void
}) {
  const { provider, roots, concurrency, maxRounds, probe, onRound } = options
  if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new Error('Invalid discovery round limit')
  let discovered = 0
  for (let round = 1; round <= maxRounds; round += 1) {
    const targets = await provider.discover(() =>
      forEachConcurrent(roots, concurrency, async (root) => {
        await probe(root)
      })
    )
    onRound?.(round, targets)
    if (targets.length === 0) return { rounds: round, discovered, converged: true }
    discovered += targets.length
    await provider.prefetch(targets)
  }
  return { rounds: maxRounds, discovered, converged: false }
}
