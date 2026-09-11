import { expect, it } from 'vitest'
import type { NormalizedTarget } from '../../src/backfill/manifest'
import { targetOutcome } from '../../src/backfill/target-outcome'
import type { ResolvedPricePath } from '../../src/sources/onchain/types'

const target: NormalizedTarget = {
  chainId: 1,
  chain: 'ethereum',
  token: '0x0000000000000000000000000000000000000001',
  tokenLowercase: '0x0000000000000000000000000000000000000001',
  eodTimestamp: 1704067199
}
it.each([-300, 300])('reports selected method and signed observation offset %s', (offset) => {
  const path: ResolvedPricePath = {
    chainId: 1,
    token: target.token,
    requestedTimestamp: target.eodTimestamp,
    observedTimestamp: target.eodTimestamp + offset,
    priceUsd: 1.04,
    source: 'curve',
    adapter: 'curve',
    symbol: null,
    confidence: null,
    blockNumber: 1,
    inputs: [],
    metadata: {}
  }
  expect(targetOutcome(target, 'inserted', path)).toMatchObject({
    status: 'inserted',
    price: 1.04,
    source: 'curve',
    method: 'curve',
    observedTimestamp: target.eodTimestamp + offset,
    signedOffsetSeconds: offset
  })
  expect(
    targetOutcome(target, 'inserted', {
      ...path,
      metadata: { provenance: 'existing-token_prices-row' }
    })
  ).toMatchObject({ observedTimestamp: null, signedOffsetSeconds: null })
})
