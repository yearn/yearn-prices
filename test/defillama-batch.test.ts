import { describe, expect, it } from 'vitest'
import {
  batchSpacedTimestamps,
  buildDefiLlamaPayloads,
  DEFI_LLAMA_TIMESTAMP_BATCH,
  DEFI_LLAMA_TOKEN_BATCH
} from '../src/sources/defillama/batch'

const D16 = 1_755_388_799 // 2025-08-16 23:59:59Z
const D17 = D16 + 86_400

describe('batchSpacedTimestamps', () => {
  it('splits timestamps closer than the search width into separate batches', () => {
    expect(batchSpacedTimestamps([D16, D16 + 300])).toEqual([[D16], [D16 + 300]])
  })

  it('splits a gap wider than the strict match window but inside the search width', () => {
    expect(batchSpacedTimestamps([D16, D16 + 3 * 3_600])).toEqual([[D16], [D16 + 3 * 3_600]])
  })

  it('keeps day-spaced timestamps in one batch', () => {
    expect(batchSpacedTimestamps([D16, D17])).toEqual([[D16, D17]])
  })

  it('caps a batch at DEFI_LLAMA_TIMESTAMP_BATCH', () => {
    const timestamps = Array.from({ length: DEFI_LLAMA_TIMESTAMP_BATCH + 1 }, (_, index) => D16 + index * 86_400)
    const batches = batchSpacedTimestamps(timestamps)

    expect(batches.map((batch) => batch.length)).toEqual([DEFI_LLAMA_TIMESTAMP_BATCH, 1])
  })
})

describe('buildDefiLlamaPayloads', () => {
  it('puts both chunks of a near-midnight split into separate payloads', () => {
    const now = D16 + 3 * 3_600 // 3h past UTC midnight: yesterday's EOD and now are < 6h apart
    const payloads = buildDefiLlamaPayloads({ 'ethereum:0xaaa': [D16, D17] }, now)

    expect(payloads).toHaveLength(2)
    expect(payloads[0]['ethereum:0xaaa']).toEqual([D16])
    expect(payloads[1]['ethereum:0xaaa']).toEqual([now])
  })

  it('emits every fetch timestamp exactly once across payloads', () => {
    const now = D16 + 121
    const payloads = buildDefiLlamaPayloads({ 'ethereum:0xaaa': [D16, D17], 'ethereum:0xbbb': [D16] }, now)

    const emitted = payloads.flatMap((payload) =>
      Object.entries(payload).flatMap(([tokenKey, timestamps]) =>
        timestamps.map((timestamp) => `${tokenKey}:${timestamp}`)
      )
    )
    expect(new Set(emitted).size).toBe(emitted.length)
    expect(emitted.sort()).toEqual([`ethereum:0xaaa:${D16}`, `ethereum:0xaaa:${now}`, `ethereum:0xbbb:${D16}`].sort())
  })

  it('batches single-chunk tokens together up to the token batch size', () => {
    const grouped = Object.fromEntries(
      Array.from({ length: DEFI_LLAMA_TOKEN_BATCH + 1 }, (_, index) => [`ethereum:0x${index}`, [D16]])
    )
    const payloads = buildDefiLlamaPayloads(grouped, D17 + 43_200)

    expect(payloads.map((payload) => Object.keys(payload).length)).toEqual([DEFI_LLAMA_TOKEN_BATCH, 1])
  })
})
