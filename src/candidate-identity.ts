import type { PriceSource } from './types'

export const PRICE_SELECTION_POLICY_VERSION = 'eod-candidate-selection-v1'
export const ONCHAIN_ADAPTER_VERSION = 'historical-onchain-v1'
export const HISTORICAL_MARKET_ADAPTER_VERSION = 'defillama-eod-v1'

interface CandidateIdentityInput {
  source: PriceSource
  adapter?: string | null
  metadata?: Record<string, unknown>
}

function nestedProviderIdentifier(metadata: Record<string, unknown>): string | null {
  if (typeof metadata.matchedIdentifier === 'string' && metadata.matchedIdentifier.length > 0) {
    return metadata.matchedIdentifier
  }
  const mapping = metadata.mapping
  if (
    mapping != null
    && typeof mapping === 'object'
    && !Array.isArray(mapping)
    && typeof (mapping as Record<string, unknown>).providerIdentifier === 'string'
  ) {
    return (mapping as Record<string, string>).providerIdentifier
  }
  return null
}

export function priceCandidateId(input: CandidateIdentityInput): string {
  const adapter = input.adapter?.trim() || input.source
  const providerIdentifier = input.metadata ? nestedProviderIdentifier(input.metadata) : null
  const adapterVersion = input.metadata && typeof input.metadata.adapterVersion === 'string'
    ? input.metadata.adapterVersion.trim()
    : ''
  return [
    adapter,
    adapterVersion ? `version:${adapterVersion}` : null,
    providerIdentifier ? `provider:${providerIdentifier.toLowerCase()}` : null,
  ].filter(Boolean).join('|')
}
