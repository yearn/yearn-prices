import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { EXACT_READ_CHUNK_SIZE, MAXIMUM_ACCEPTED_OFFSET_SECONDS } from '../../src/backfill/constants'
import { type FinalizationTarget, finalizeBackfillTargets } from '../../src/backfill/finalize'
import { validateGraphResolution } from '../../src/backfill/graph-validation'
import type { ParsedManifest } from '../../src/backfill/manifest'
import { priceKey, readPricedKeys } from '../../src/backfill/priced-keys'
import { gitRevision } from '../../src/backfill/provenance'
import { targetOutcome } from '../../src/backfill/target-outcome'
import type { createPool } from '../../src/db'
import {
  createChainlinkHistoricalSource,
  createDefiLlamaAliasHistoricalSource,
  createDefiLlamaHistoricalSource
} from '../../src/sources'
import type { GraphNode } from '../../src/sources/onchain/graph'
import { preflightTokenCasings } from '../backfill-historical-gaps'
import { storedTargetGuard } from './curve-lp-guard'
import { replayGraph } from './graph-replay'
import { offlineProvider } from './offline-provider'
import { storedHistoricalPrices } from './stored-historical-prices'

export interface GraphBackfillSummary {
  inserted: number
  wouldInsert: number
  skippedConcurrentExisting: number
  unresolved: number
  rejectedImplausible: number
}

export async function runGraphBackfill(options: {
  pool: ReturnType<typeof createPool>
  manifest: ParsedManifest
  out: string
  write: boolean
  concurrency: number
  providerRps: number
  provider?: ReturnType<typeof offlineProvider>
}): Promise<GraphBackfillSummary> {
  const { pool, manifest, out, write } = options
  const emit = (record: unknown) => appendFileSync(out, JSON.stringify(record) + '\n')
  writeFileSync(
    out,
    JSON.stringify({
      type: 'run',
      startedAt: new Date().toISOString(),
      codeRevision: gitRevision(),
      mode: write ? 'write' : 'dry-run',
      manifestDigest: manifest.digest,
      targets: manifest.targets.length,
      maximumAcceptedOffsetSeconds: MAXIMUM_ACCEPTED_OFFSET_SECONDS
    }) + '\n',
    { flag: 'wx' }
  )
  let settled = 0
  try {
    await preflightTokenCasings(pool, manifest.targets, EXACT_READ_CHUNK_SIZE)
    const priced = await readPricedKeys(pool, manifest.targets, EXACT_READ_CHUNK_SIZE)
    const pending = manifest.targets.filter(
      (target) => !priced.has(priceKey(target.chain, target.token, target.eodTimestamp))
    )
    emit({ type: 'existing', skipped: manifest.targets.length - pending.length })
    for (const target of manifest.targets)
      if (priced.has(priceKey(target.chain, target.token, target.eodTimestamp)))
        emit(targetOutcome(target, 'skipped_existing'))
    let summary: GraphBackfillSummary = {
      inserted: 0,
      wouldInsert: 0,
      skippedConcurrentExisting: 0,
      unresolved: 0,
      rejectedImplausible: 0
    }
    if (pending.length) {
      const pendingFile = out + '.manifest.json'
      const replayFile = out + '.replay.jsonl'
      writeFileSync(pendingFile, JSON.stringify({ version: 1, targets: pending }), { flag: 'wx' })
      writeFileSync(replayFile, '', { flag: 'wx' })
      const provider = options.provider ?? offlineProvider(options.providerRps)
      await replayGraph({
        targets: pending.map((target) => ({
          chainId: target.chainId,
          token: target.token,
          timestamp: target.eodTimestamp
        })),
        sources: [
          createDefiLlamaHistoricalSource(provider),
          createChainlinkHistoricalSource(),
          createDefiLlamaAliasHistoricalSource(provider)
        ],
        stored: storedHistoricalPrices(pool),
        provider,
        out: replayFile,
        concurrency: options.concurrency,
        maxNodes: 32000,
        clean: () => 'Pricing source failed; consult structured failure reason'
      })
      const graphBytes = readFileSync(replayFile + '.graph.json')
      const graph = JSON.parse(graphBytes.toString()) as { roots: string[]; nodes: GraphNode[] }
      if (graph.roots.length !== pending.length) throw new Error('Graph did not return all requested roots')
      const byKey = new Map(graph.nodes.map((node) => [node.key, node]))
      const finalTargets: FinalizationTarget[] = []
      for (const [index, target] of pending.entries()) {
        const root = byKey.get(graph.roots[index])
        if (!root) throw new Error('Missing graph root')
        if (!root.path) {
          emit({ type: 'unresolved', target, reason: root.reason, graphKey: root.key })
          emit(targetOutcome(target, 'unresolved', null, root.reason))
          continue
        }
        try {
          const resolution = validateGraphResolution(root, target, byKey)
          finalTargets.push({ ...target, resolution })
          emit({ type: 'validated', target, resolution, graphKey: root.key })
        } catch (error) {
          emit({ type: 'rejected', target, reason: (error as Error).message })
          emit(targetOutcome(target, 'rejected', null, (error as Error).message))
        }
      }
      emit({
        type: 'evidence',
        file: replayFile + '.graph.json',
        sha256: createHash('sha256').update(graphBytes).digest('hex'),
        eligible: finalTargets.length
      })
      const rootsByTarget = new Map(
        pending.map((target, index) => [
          priceKey(target.chain, target.token, target.eodTimestamp),
          byKey.get(graph.roots[index])!
        ])
      )
      const result = await finalizeBackfillTargets(pool, finalTargets, {
        dryRun: !write,
        isPlausible: storedTargetGuard(pool),
        onBatchSettled(batch) {
          settled += batch.results.length
          for (const result of batch.results) {
            const status = !write && result.status === 'inserted' ? 'would-insert' : result.status
            const root = rootsByTarget.get(priceKey(result.chain, result.token, result.eodTimestamp))!
            emit(
              targetOutcome(
                result,
                status,
                result.status === 'inserted' ? root.path : null,
                result.status === 'rejected_implausible' ? 'implausible-lp-quote' : null
              )
            )
          }
          emit({
            type: 'finalized-batch',
            mode: write ? 'write' : 'dry-run',
            results: batch.results.map((result) => ({
              ...result,
              status: !write && result.status === 'inserted' ? 'would-insert' : result.status
            }))
          })
        }
      })
      summary = {
        inserted: write ? result.inserted : 0,
        wouldInsert: write ? 0 : result.inserted,
        skippedConcurrentExisting: result.skippedConcurrentExisting,
        unresolved: pending.length - finalTargets.length + result.unresolved,
        rejectedImplausible: result.rejectedImplausible
      }
    }
    emit({ type: 'summary', ...summary })
    emit({ type: 'complete', finishedAt: new Date().toISOString() })
    return summary
  } catch (error) {
    emit({
      errorType: error instanceof Error ? error.name : 'UnknownError',
      type: 'fatal',
      settled,
      message: 'Backfill stopped; retain evidence and rerun with a new output path. Existing rows are skipped.'
    })
    throw error
  }
}
