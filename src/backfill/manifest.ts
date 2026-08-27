import { createHash } from 'node:crypto'
import { CHAIN_ID_TO_NAME, normalizeTokenAddress } from '../utils/chains'
import { currentUtcDayEnd, nowUnix } from '../utils/time'
import { MANIFEST_VERSION, MAXIMUM_MANIFEST_BYTES, MAXIMUM_MANIFEST_TARGETS } from './constants'

const DAY_SECONDS = 86_400
const TOKEN_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

export interface NormalizedTarget {
  chainId: number
  chain: string
  token: `0x${string}`
  tokenLowercase: string
  eodTimestamp: number
}

export interface ParsedManifest {
  version: number
  digest: string
  byteLength: number
  requestedCount: number
  duplicateCount: number
  targets: NormalizedTarget[]
}

export interface ParseManifestOptions {
  now?: number
  maximumBytes?: number
  maximumTargets?: number
}

export class ManifestError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid manifest: ${issues.join('; ')}`)
    this.name = 'ManifestError'
    this.issues = issues
  }
}

function toBuffer(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
}

function normalizeTarget(raw: unknown, index: number, closedBefore: number, issues: string[]): NormalizedTarget | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push(`target ${index}: not an object`)
    return null
  }

  const entry = raw as Record<string, unknown>
  const { chainId, token, eodTimestamp } = entry
  let valid = true

  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    issues.push(`target ${index}: chainId must be a positive safe integer`)
    valid = false
  } else if (!(chainId in CHAIN_ID_TO_NAME)) {
    issues.push(`target ${index}: unsupported chainId ${chainId}`)
    valid = false
  }

  if (typeof token !== 'string' || !TOKEN_ADDRESS_PATTERN.test(token)) {
    issues.push(`target ${index}: token must be a valid EVM address`)
    valid = false
  }

  if (typeof eodTimestamp !== 'number' || !Number.isSafeInteger(eodTimestamp) || eodTimestamp <= 0) {
    issues.push(`target ${index}: eodTimestamp must be a positive safe integer`)
    valid = false
  } else if (eodTimestamp % DAY_SECONDS !== DAY_SECONDS - 1) {
    issues.push(`target ${index}: eodTimestamp ${eodTimestamp} is not an exact UTC end of day`)
    valid = false
  } else if (eodTimestamp >= closedBefore) {
    issues.push(`target ${index}: eodTimestamp ${eodTimestamp} is not a closed day`)
    valid = false
  }

  if (!valid) {
    return null
  }

  const chainIdValue = chainId as number
  const tokenValue = token as string

  return {
    chainId: chainIdValue,
    chain: CHAIN_ID_TO_NAME[chainIdValue as keyof typeof CHAIN_ID_TO_NAME],
    token: normalizeTokenAddress(tokenValue),
    tokenLowercase: tokenValue.toLowerCase(),
    eodTimestamp: eodTimestamp as number
  }
}

export function manifestDigest(input: string | Uint8Array): string {
  return createHash('sha256').update(toBuffer(input)).digest('hex')
}

export function parseManifest(input: string | Uint8Array, options: ParseManifestOptions = {}): ParsedManifest {
  const bytes = toBuffer(input)
  const maximumBytes = options.maximumBytes ?? MAXIMUM_MANIFEST_BYTES
  const maximumTargets = options.maximumTargets ?? MAXIMUM_MANIFEST_TARGETS

  if (bytes.byteLength > maximumBytes) {
    throw new ManifestError([`manifest is ${bytes.byteLength} bytes, above the ${maximumBytes} byte maximum`])
  }

  let document: unknown
  try {
    document = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new ManifestError([`manifest is not valid JSON: ${(error as Error).message}`])
  }

  if (document == null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ManifestError(['manifest must be a JSON object'])
  }

  const { version, targets } = document as Record<string, unknown>
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError([`unsupported manifest version: ${String(version)}`])
  }
  if (!Array.isArray(targets)) {
    throw new ManifestError(['manifest targets must be an array'])
  }
  if (targets.length > maximumTargets) {
    throw new ManifestError([`manifest has ${targets.length} targets, above the ${maximumTargets} target maximum`])
  }

  const closedBefore = currentUtcDayEnd(options.now ?? nowUnix())
  const issues: string[] = []
  const seen = new Map<string, NormalizedTarget>()
  let duplicateCount = 0

  for (const [index, raw] of targets.entries()) {
    const target = normalizeTarget(raw, index, closedBefore, issues)
    if (!target) {
      continue
    }

    const identity = `${target.chainId}:${target.tokenLowercase}:${target.eodTimestamp}`
    if (seen.has(identity)) {
      duplicateCount += 1
      continue
    }
    seen.set(identity, target)
  }

  if (issues.length > 0) {
    throw new ManifestError(issues)
  }

  return {
    version: MANIFEST_VERSION,
    digest: manifestDigest(bytes),
    byteLength: bytes.byteLength,
    requestedCount: targets.length,
    duplicateCount,
    targets: [...seen.values()]
  }
}
