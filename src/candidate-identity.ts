import type { PriceSource } from './types'

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
  return providerIdentifier
    ? `${adapter}|provider:${providerIdentifier.toLowerCase()}`
    : adapter
}
