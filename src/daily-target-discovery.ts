import { chainIdToName, normalizeTokenAddress } from './chains'
import type { DailyPriceTargetInput, UnsupportedDailyPriceTargetInput } from './daily-prices'

export const TVL_PRICE_TARGET_INVENTORY_SCHEMA_VERSION = '1.1.0'
export const MAX_TVL_PRICE_TARGET_INVENTORY_BYTES = 10 * 1024 * 1024
export const TVL_PRICE_TARGET_INVENTORY_TIMEOUT_MS = 30_000

const ROLES = [
  'current-underlying',
  'historical-underlying',
  'v1-direct',
  'v1-recursive-leaf',
  'recursive-constituent',
  'curation',
  'extra-product',
] as const
const REQUIREMENTS = ['current', 'historical'] as const
const ORIGIN_TYPES = ['vault', 'legacy-curve', 'configured-extra'] as const
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

type InventoryRole = typeof ROLES[number]
type InventoryRequirement = typeof REQUIREMENTS[number]
type InventoryOriginType = typeof ORIGIN_TYPES[number]

interface InventoryOrigin {
  type: InventoryOriginType
  id: string
  roles: InventoryRole[]
}

interface InventoryTarget {
  key: string
  chainId: number
  address: `0x${string}`
  roles: InventoryRole[]
  requirements: InventoryRequirement[]
  origins: InventoryOrigin[]
  support: Record<string, unknown>
}

interface MutableInventoryTarget extends Omit<InventoryTarget, 'roles' | 'requirements' | 'origins'> {
  roles: Set<InventoryRole>
  requirements: Set<InventoryRequirement>
  origins: Map<string, { type: InventoryOriginType; id: string; roles: Set<InventoryRole> }>
}

export interface MalformedInventoryEntry {
  index: number
  key: string | null
  reason: string
}

export interface TvlDailyTargetDiscovery {
  schemaVersion: string
  sourceState: Record<string, unknown>
  targets: DailyPriceTargetInput[]
  unsupportedTargets: UnsupportedDailyPriceTargetInput[]
  malformedEntries: MalformedInventoryEntry[]
  producerProblems: Array<Record<string, unknown>>
  summary: {
    inventoryTargets: number
    normalizedTargets: number
    supportedTargets: number
    unsupportedTargets: number
    malformedEntries: number
  }
}

export interface DailyTargetDiscoveryDependencies {
  request?: typeof fetch
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1'
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength != null) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TVL_PRICE_TARGET_INVENTORY_BYTES) {
      throw new Error(`TVL price-target inventory exceeds ${MAX_TVL_PRICE_TARGET_INVENTORY_BYTES} bytes`)
    }
  }

  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  let raw = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > MAX_TVL_PRICE_TARGET_INVENTORY_BYTES) {
        await reader.cancel()
        throw new Error(`TVL price-target inventory exceeds ${MAX_TVL_PRICE_TARGET_INVENTORY_BYTES} bytes`)
      }
      raw += decoder.decode(value, { stream: true })
    }
    return raw + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseStringSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): Set<T> {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`)
  const result = new Set<T>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) throw new Error(`${name} contains an unsupported value`)
    result.add(entry as T)
  }
  return result
}

function parseOrigins(value: unknown): MutableInventoryTarget['origins'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('origins must be a non-empty array')
  const origins: MutableInventoryTarget['origins'] = new Map()
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !ORIGIN_TYPES.includes(raw.type as InventoryOriginType)) {
      throw new Error('origin.type is invalid')
    }
    if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('origin.id is invalid')
    const roles = parseStringSet(raw.roles, ROLES, 'origin.roles')
    const key = `${raw.type}:${raw.id}`
    const existing = origins.get(key) ?? {
      type: raw.type as InventoryOriginType,
      id: raw.id,
      roles: new Set<InventoryRole>(),
    }
    for (const role of roles) existing.roles.add(role)
    origins.set(key, existing)
  }
  return origins
}

function parseTarget(value: unknown): MutableInventoryTarget {
  if (!isRecord(value)) throw new Error('target must be an object')
  if (!Number.isSafeInteger(value.chainId) || Number(value.chainId) <= 0) throw new Error('chainId must be a positive integer')
  const chainId = Number(value.chainId)
  if (typeof value.address !== 'string') throw new Error('address is required')
  const address = normalizeTokenAddress(value.address)
  if (address.toLowerCase() === ZERO_ADDRESS) throw new Error('address must not be the zero address')
  const key = `${chainId}:${address.toLowerCase()}`
  if (value.key !== key) throw new Error(`key must equal ${key}`)
  if (!isRecord(value.support) || (value.support.status !== 'supported' && value.support.status !== 'unsupported')) {
    throw new Error('support status is invalid')
  }
  return {
    key,
    chainId,
    address,
    roles: parseStringSet(value.roles, ROLES, 'roles'),
    requirements: parseStringSet(value.requirements, REQUIREMENTS, 'requirements'),
    origins: parseOrigins(value.origins),
    support: value.support,
  }
}

function mergeTarget(target: MutableInventoryTarget, incoming: MutableInventoryTarget): void {
  for (const role of incoming.roles) target.roles.add(role)
  for (const requirement of incoming.requirements) target.requirements.add(requirement)
  for (const [key, origin] of incoming.origins) {
    const existing = target.origins.get(key) ?? { type: origin.type, id: origin.id, roles: new Set<InventoryRole>() }
    for (const role of origin.roles) existing.roles.add(role)
    target.origins.set(key, existing)
  }
  if (incoming.support.status === 'supported') target.support = incoming.support
}

function orderedValues<T extends string>(values: Set<T>, order: readonly T[]): T[] {
  return order.filter(value => values.has(value))
}

function stableMetadata(
  target: MutableInventoryTarget,
  inventoryUrl: string,
  schemaVersion: string,
  sourceState: Record<string, unknown>,
): Record<string, unknown> {
  return {
    origin: 'tvl-price-target-inventory',
    discoverySource: inventoryUrl,
    inventorySchemaVersion: schemaVersion,
    inventorySourceState: sourceState,
    inventoryKey: target.key,
    chainId: target.chainId,
    roles: orderedValues(target.roles, ROLES),
    requirements: orderedValues(target.requirements, REQUIREMENTS),
    origins: [...target.origins.values()]
      .sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id))
      .map(origin => ({ type: origin.type, id: origin.id, roles: orderedValues(origin.roles, ROLES) })),
    producerSupport: target.support,
  }
}

export function parseTvlPriceTargetInventory(
  value: unknown,
  eodTimestamp: number,
  inventoryUrl: string,
): TvlDailyTargetDiscovery {
  if (!isRecord(value)) throw new Error('TVL price-target inventory must be an object')
  if (typeof value.schemaVersion !== 'string') throw new Error('TVL price-target inventory schemaVersion is required')
  const [major] = value.schemaVersion.split('.')
  if (major !== TVL_PRICE_TARGET_INVENTORY_SCHEMA_VERSION.split('.')[0]) {
    throw new Error(`Unsupported TVL price-target inventory schema version: ${value.schemaVersion}`)
  }
  if (!Array.isArray(value.targets)) throw new Error('TVL price-target inventory targets must be an array')
  const sourceState = isRecord(value.sourceState) ? value.sourceState : {}
  const producerProblems = Array.isArray(value.problems)
    ? value.problems.filter(isRecord)
    : []
  const malformedEntries: MalformedInventoryEntry[] = []
  const normalized = new Map<string, MutableInventoryTarget>()

  for (const [index, raw] of value.targets.entries()) {
    try {
      const target = parseTarget(raw)
      const existing = normalized.get(target.key)
      if (existing) mergeTarget(existing, target)
      else normalized.set(target.key, target)
    } catch (error) {
      malformedEntries.push({
        index,
        key: isRecord(raw) && typeof raw.key === 'string' ? raw.key : null,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const targets: DailyPriceTargetInput[] = []
  const unsupportedTargets: UnsupportedDailyPriceTargetInput[] = []
  const ordered = [...normalized.values()].sort((left, right) => (
    left.chainId - right.chainId || left.address.toLowerCase().localeCompare(right.address.toLowerCase())
  ))
  for (const target of ordered) {
    const metadata = stableMetadata(target, inventoryUrl, value.schemaVersion, sourceState)
    const chain = chainIdToName(target.chainId)
    if (chain) {
      targets.push({ chain, token: target.address, eodTimestamp, metadata: { ...metadata, consumerSupport: 'supported' } })
    } else {
      unsupportedTargets.push({
        chain: String(target.chainId),
        token: target.address,
        eodTimestamp,
        failureReason: `yearn-prices has no configured chain, RPC, or adapter support for chain ${target.chainId}`,
        metadata: { ...metadata, consumerSupport: 'unsupported' },
      })
    }
  }

  if (targets.length === 0 && unsupportedTargets.length === 0) {
    throw new Error('TVL price-target inventory did not yield any valid targets')
  }
  return {
    schemaVersion: value.schemaVersion,
    sourceState,
    targets,
    unsupportedTargets,
    malformedEntries,
    producerProblems,
    summary: {
      inventoryTargets: value.targets.length,
      normalizedTargets: ordered.length,
      supportedTargets: targets.length,
      unsupportedTargets: unsupportedTargets.length,
      malformedEntries: malformedEntries.length,
    },
  }
}

export async function discoverTvlDailyTargets(
  eodTimestamp: number,
  inventoryUrl: string,
  dependencies: DailyTargetDiscoveryDependencies = {},
): Promise<TvlDailyTargetDiscovery> {
  if (!inventoryUrl.trim()) throw new Error('TVL_PRICE_TARGET_INVENTORY_URL is required')
  let url: URL
  try {
    url = new URL(inventoryUrl)
  } catch {
    throw new Error('TVL_PRICE_TARGET_INVENTORY_URL must be an absolute URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('TVL_PRICE_TARGET_INVENTORY_URL must use https or loopback http')
  }
  const timeoutMs = dependencies.timeoutMs ?? TVL_PRICE_TARGET_INVENTORY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('TVL price-target inventory timeout must be a positive integer')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let raw: string
  try {
    const response = await (dependencies.request ?? fetch)(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`TVL price-target inventory request failed with HTTP ${response.status}`)
    raw = await readBoundedResponseText(response)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`TVL price-target inventory request timed out after ${timeoutMs} ms`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('TVL price-target inventory response is not valid JSON')
  }
  const discoverySource = new URL(url)
  discoverySource.username = ''
  discoverySource.password = ''
  discoverySource.search = ''
  discoverySource.hash = ''
  return parseTvlPriceTargetInventory(value, eodTimestamp, discoverySource.toString())
}
