import { DEFI_LLAMA_SEARCH_WIDTH_SECONDS } from '../../clients/defillama'
import { nowUnix, toFetchTimestamp } from '../../utils/time'

export const DEFI_LLAMA_TOKEN_BATCH = 5
export const DEFI_LLAMA_TIMESTAMP_BATCH = 20

export function batchSpacedTimestamps(sorted: number[], batchSize = DEFI_LLAMA_TIMESTAMP_BATCH): number[][] {
  const batches: number[][] = []
  let current: number[] = []
  for (const timestamp of sorted) {
    const tooClose = current.length > 0 && timestamp - current[current.length - 1] < DEFI_LLAMA_SEARCH_WIDTH_SECONDS
    if (current.length >= batchSize || tooClose) {
      batches.push(current)
      current = []
    }
    current.push(timestamp)
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

export function buildDefiLlamaPayloads(
  grouped: Record<string, number[]>,
  currentTimestamp = nowUnix()
): Array<Record<string, number[]>> {
  const tokenChunks: Array<{ tokenKey: string; timestamps: number[] }> = []
  for (const [tokenKey, timestamps] of Object.entries(grouped)) {
    const fetchTimestamps = [
      ...new Set(timestamps.map((timestamp) => toFetchTimestamp(timestamp, currentTimestamp)))
    ].sort((left, right) => left - right)
    for (const timestampChunk of batchSpacedTimestamps(fetchTimestamps)) {
      tokenChunks.push({ tokenKey, timestamps: timestampChunk })
    }
  }

  const groups: Array<Map<string, number[]>> = []
  for (const item of tokenChunks) {
    const target = groups.find((group) => group.size < DEFI_LLAMA_TOKEN_BATCH && !group.has(item.tokenKey))
    if (target) {
      target.set(item.tokenKey, item.timestamps)
    } else {
      groups.push(new Map([[item.tokenKey, item.timestamps]]))
    }
  }

  return groups.map((group) => Object.fromEntries(group))
}
