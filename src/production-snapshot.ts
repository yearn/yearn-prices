import { CHAIN_NAME_TO_ID, normalizeTokenAddress, SUPPORTED_CHAIN_NAMES } from './chains'
import type { DailyPriceTargetInput } from './daily-prices'
import { normalizeToEndOfDay } from './time'
import { SOURCE_PRIORITY, type PriceSource, type TokenPriceWrite } from './types'

export const PRODUCTION_EOD_SNAPSHOT_SCHEMA_VERSION = 1

export type ProductionImportClassification =
  | 'trusted-production-observation-structural'
  | 'requires-independent-validation'
  | 'automatic-peg-repair'
  | 'missing'

export interface ProductionEodManifest {
  schemaVersion: 1
  kind: 'manifest'
  generatedAt: string
  endpoint: string
  eventCount: number
  targetCount: number
  targetCountByChain: Record<string, number>
}

export interface ProductionEodPriceRecord {
  schemaVersion: 1
  kind: 'price'
  chainId: number
  chain: string
  token: string
  timestamp: number
  price: number
  symbol: string | null
  confidence: number | null
  source: PriceSource
  acceptedForLocalSeed: boolean
  rejectionReason: string | null
}

export interface ProductionEodMissingRecord {
  schemaVersion: 1
  kind: 'missing'
  chainId: number
  chain: string
  token: string
  timestamp: number
  reason: 'not-returned'
}

export type ProductionEodSnapshotRecord =
  | ProductionEodManifest
  | ProductionEodPriceRecord
  | ProductionEodMissingRecord

export interface ProductionImportPolicy {
  classification: ProductionImportClassification
  accepted: boolean
  reason: string | null
}

const STRUCTURALLY_TRUSTED_PRODUCTION_SOURCES = new Set<PriceSource>([
  'defillama',
  'on-chain-oracle',
  'bobs-api',
  'enso',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function parseSource(value: unknown): PriceSource {
  if (typeof value !== 'string' || !SOURCE_PRIORITY.includes(value as PriceSource)) {
    throw new Error(`Unsupported production price source: ${String(value)}`)
  }
  return value as PriceSource
}

function parseCommonTarget(value: Record<string, unknown>, lineNumber: number) {
  if (value.schemaVersion !== PRODUCTION_EOD_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`Snapshot line ${lineNumber} has an unsupported schema version`)
  }
  if (typeof value.chain !== 'string' || !SUPPORTED_CHAIN_NAMES.has(value.chain.toLowerCase())) {
    throw new Error(`Snapshot line ${lineNumber} has an unsupported chain`)
  }
  if (!isNonNegativeInteger(value.chainId)) throw new Error(`Snapshot line ${lineNumber} has an invalid chain ID`)
  if (!isNonNegativeInteger(value.timestamp) || normalizeToEndOfDay(value.timestamp) !== value.timestamp) {
    throw new Error(`Snapshot line ${lineNumber} is not an exact UTC day-end target`)
  }
  const chain = value.chain.toLowerCase()
  if (CHAIN_NAME_TO_ID[chain] !== value.chainId) {
    throw new Error(`Snapshot line ${lineNumber} has mismatched chain name and ID`)
  }
  return {
    chainId: value.chainId,
    chain,
    token: normalizeTokenAddress(String(value.token)),
    timestamp: value.timestamp,
  }
}

export function parseProductionEodSnapshotLine(line: string, lineNumber: number): ProductionEodSnapshotRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`Invalid JSON on snapshot line ${lineNumber}`)
  }
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error(`Snapshot line ${lineNumber} must be an object with a kind`)
  }
  if (value.kind === 'manifest') {
    if (
      value.schemaVersion !== PRODUCTION_EOD_SNAPSHOT_SCHEMA_VERSION
      || typeof value.generatedAt !== 'string'
      || !Number.isFinite(Date.parse(value.generatedAt))
      || typeof value.endpoint !== 'string'
      || value.endpoint.length === 0
      || !isNonNegativeInteger(value.eventCount)
      || !isNonNegativeInteger(value.targetCount)
      || !isRecord(value.targetCountByChain)
    ) {
      throw new Error(`Snapshot line ${lineNumber} has an invalid manifest`)
    }
    for (const [chain, count] of Object.entries(value.targetCountByChain)) {
      if (!SUPPORTED_CHAIN_NAMES.has(chain) || !isNonNegativeInteger(count)) {
        throw new Error(`Snapshot line ${lineNumber} has an invalid per-chain target count`)
      }
    }
    return value as unknown as ProductionEodManifest
  }

  const target = parseCommonTarget(value, lineNumber)
  if (value.kind === 'missing') {
    if (value.reason !== 'not-returned') throw new Error(`Snapshot line ${lineNumber} has an invalid missing reason`)
    return { schemaVersion: 1, kind: 'missing', ...target, reason: 'not-returned' }
  }
  if (value.kind !== 'price') throw new Error(`Snapshot line ${lineNumber} has an unsupported kind`)
  if (
    typeof value.price !== 'number'
    || !Number.isFinite(value.price)
    || value.price <= 0
    || (value.symbol != null && typeof value.symbol !== 'string')
    || (value.confidence != null && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)))
    || typeof value.acceptedForLocalSeed !== 'boolean'
    || (value.rejectionReason != null && typeof value.rejectionReason !== 'string')
  ) {
    throw new Error(`Snapshot line ${lineNumber} has an invalid price record`)
  }
  return {
    schemaVersion: 1,
    kind: 'price',
    ...target,
    price: value.price,
    symbol: value.symbol as string | null,
    confidence: value.confidence as number | null,
    source: parseSource(value.source),
    acceptedForLocalSeed: value.acceptedForLocalSeed,
    rejectionReason: value.rejectionReason as string | null,
  }
}

export function validateProductionEodSnapshot(records: ProductionEodSnapshotRecord[]): {
  manifest: ProductionEodManifest
  targets: Array<ProductionEodPriceRecord | ProductionEodMissingRecord>
} {
  const manifests = records.filter(record => record.kind === 'manifest')
  if (manifests.length !== 1) throw new Error('Production EOD snapshot must contain exactly one manifest')
  const manifest = manifests[0]
  const targets = records.filter(record => record.kind !== 'manifest')
  if (targets.length !== manifest.targetCount) {
    throw new Error(`Snapshot manifest declares ${manifest.targetCount} targets but contains ${targets.length}`)
  }

  const uniqueTargets = new Set<string>()
  const countsByChain: Record<string, number> = {}
  for (const target of targets) {
    const key = `${target.chain}:${target.token}:${target.timestamp}`
    if (uniqueTargets.has(key)) throw new Error(`Production EOD snapshot contains duplicate target ${key}`)
    uniqueTargets.add(key)
    countsByChain[target.chain] = (countsByChain[target.chain] ?? 0) + 1
  }
  const declaredTotal = Object.values(manifest.targetCountByChain).reduce((sum, count) => sum + count, 0)
  if (declaredTotal !== manifest.targetCount) {
    throw new Error('Snapshot manifest per-chain target counts do not sum to its target count')
  }
  const chains = new Set([...Object.keys(manifest.targetCountByChain), ...Object.keys(countsByChain)])
  for (const chain of chains) {
    if ((manifest.targetCountByChain[chain] ?? 0) !== (countsByChain[chain] ?? 0)) {
      throw new Error(`Snapshot manifest target count does not match records for ${chain}`)
    }
  }
  return { manifest, targets }
}

export function classifyProductionPrice(record: ProductionEodPriceRecord): ProductionImportPolicy {
  if (record.source === 'stable-peg') {
    return {
      classification: 'automatic-peg-repair',
      accepted: false,
      reason: 'Automatic stablecoin peg evidence requires independent repair',
    }
  }
  if (
    record.acceptedForLocalSeed
    && record.rejectionReason == null
    && STRUCTURALLY_TRUSTED_PRODUCTION_SOURCES.has(record.source)
  ) {
    return {
      classification: 'trusted-production-observation-structural',
      accepted: true,
      reason: null,
    }
  }
  return {
    classification: 'requires-independent-validation',
    accepted: false,
    reason: record.rejectionReason
      ?? `Production source ${record.source} lacks sufficient provenance for strict EOD acceptance`,
  }
}

export function productionPriceWrite(
  record: ProductionEodPriceRecord,
  manifest: ProductionEodManifest,
): TokenPriceWrite {
  const policy = classifyProductionPrice(record)
  return {
    chain: record.chain,
    token: normalizeTokenAddress(record.token),
    timestamp: record.timestamp,
    price: record.price,
    symbol: record.symbol,
    confidence: record.confidence,
    source: record.source,
    observedTimestamp: null,
    classification: 'legacy',
    quality: 'legacy',
    adapter: 'production-yearn-prices-import',
    blockNumber: null,
    inputs: [],
    validationStatus: policy.accepted ? 'validated' : 'legacy-unvalidated',
    failureReason: policy.reason,
    metadata: {
      origin: 'production-yearn-prices',
      endpoint: manifest.endpoint,
      snapshotGeneratedAt: manifest.generatedAt,
      upstreamSource: record.source,
      upstreamAcceptedForLocalSeed: record.acceptedForLocalSeed,
      importClassification: policy.classification,
      observedTimestampKnown: false,
      independentlyValidated: false,
    },
  }
}

export function productionDailyTarget(
  record: ProductionEodPriceRecord | ProductionEodMissingRecord,
  manifest: ProductionEodManifest,
): DailyPriceTargetInput {
  const policy = record.kind === 'price'
    ? classifyProductionPrice(record)
    : { classification: 'missing' as const, accepted: false, reason: record.reason }
  return {
    chain: record.chain,
    token: normalizeTokenAddress(record.token),
    eodTimestamp: record.timestamp,
    metadata: {
      origin: 'production-yearn-prices-eod-import',
      snapshotGeneratedAt: manifest.generatedAt,
      importClassification: policy.classification,
      importAccepted: policy.accepted,
      importReason: policy.reason,
      ...(record.kind === 'price' ? { source: record.source, quality: 'legacy' } : {}),
      ...(record.kind === 'price' ? { classification: 'legacy' } : {}),
    },
  }
}
