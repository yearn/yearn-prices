import { describe, expect, it } from 'vitest'
import { ManifestError, manifestDigest, parseManifest } from '../../src/backfill/manifest'

const NOW = 1_735_689_600
const EOD = 1_704_153_599
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function manifest(targets: unknown[], version: unknown = 1) {
  return JSON.stringify({ version, targets })
}

function parse(targets: unknown[], version: unknown = 1) {
  return parseManifest(manifest(targets, version), { now: NOW })
}

function issues(input: string) {
  try {
    parseManifest(input, { now: NOW })
  } catch (error) {
    if (error instanceof ManifestError) {
      return error.issues
    }
    throw error
  }
  throw new Error('expected a ManifestError')
}

describe('the backfill manifest parser', () => {
  it('normalizes a valid target to both address forms', () => {
    const result = parse([{ chainId: 1, token: USDC.toLowerCase(), eodTimestamp: EOD }])
    expect(result.targets).toEqual([
      { chainId: 1, chain: 'ethereum', token: USDC, tokenLowercase: USDC.toLowerCase(), eodTimestamp: EOD }
    ])
    expect(result).toMatchObject({ version: 1, requestedCount: 1, duplicateCount: 0 })
  })

  it('rejects an unsupported version', () => {
    expect(issues(manifest([], 2))[0]).toContain('unsupported manifest version')
    expect(issues(JSON.stringify({ targets: [] }))[0]).toContain('unsupported manifest version')
  })

  it('rejects a non-object document and invalid JSON', () => {
    expect(issues('[]')[0]).toContain('must be a JSON object')
    expect(issues('{')[0]).toContain('not valid JSON')
  })

  it('rejects a missing targets array', () => {
    expect(issues(JSON.stringify({ version: 1 }))[0]).toContain('targets must be an array')
  })

  it('rejects an unsupported chain id', () => {
    expect(issues(manifest([{ chainId: 999, token: USDC, eodTimestamp: EOD }]))[0]).toContain('unsupported chainId')
    expect(issues(manifest([{ chainId: -1, token: USDC, eodTimestamp: EOD }]))[0]).toContain('positive safe integer')
    expect(issues(manifest([{ chainId: '1', token: USDC, eodTimestamp: EOD }]))[0]).toContain('positive safe integer')
  })

  it('rejects an invalid address', () => {
    expect(issues(manifest([{ chainId: 1, token: '0x1234', eodTimestamp: EOD }]))[0]).toContain('valid EVM address')
    expect(issues(manifest([{ chainId: 1, token: 42, eodTimestamp: EOD }]))[0]).toContain('valid EVM address')
  })

  it('rejects a timestamp that is not an exact UTC end of day', () => {
    expect(issues(manifest([{ chainId: 1, token: USDC, eodTimestamp: EOD - 1 }]))[0]).toContain('exact UTC end of day')
    expect(issues(manifest([{ chainId: 1, token: USDC, eodTimestamp: 1.5 }]))[0]).toContain('positive safe integer')
  })

  it('rejects an open day, including the current one', () => {
    const currentEod = 1_735_689_599
    expect(issues(manifest([{ chainId: 1, token: USDC, eodTimestamp: currentEod + 86_400 }]))[0]).toContain(
      'not a closed day'
    )
    expect(() =>
      parseManifest(manifest([{ chainId: 1, token: USDC, eodTimestamp: currentEod }]), { now: currentEod })
    ).toThrow(/not a closed day/)
  })

  it('reports every invalid target at once', () => {
    expect(
      issues(
        manifest([
          { chainId: 999, token: USDC, eodTimestamp: EOD },
          { chainId: 1, token: '0x1234', eodTimestamp: EOD }
        ])
      )
    ).toHaveLength(2)
  })

  it('deduplicates checksum-case variants and counts them', () => {
    const result = parse([
      { chainId: 1, token: USDC, eodTimestamp: EOD },
      { chainId: 1, token: USDC.toLowerCase(), eodTimestamp: EOD },
      { chainId: 10, token: USDC, eodTimestamp: EOD }
    ])
    expect(result.targets).toHaveLength(2)
    expect(result).toMatchObject({ requestedCount: 3, duplicateCount: 1 })
  })

  it('enforces the byte-size cap at the boundary', () => {
    const bytes = manifest([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    expect(parseManifest(bytes, { now: NOW, maximumBytes: bytes.length }).targets).toHaveLength(1)
    expect(() => parseManifest(bytes, { now: NOW, maximumBytes: bytes.length - 1 })).toThrow(
      /above the .* byte maximum/
    )
  })

  it('enforces the target-count cap at the boundary', () => {
    const targets = [
      { chainId: 1, token: USDC, eodTimestamp: EOD },
      { chainId: 1, token: USDC, eodTimestamp: EOD - 86_400 }
    ]
    expect(parseManifest(manifest(targets), { now: NOW, maximumTargets: 2 }).targets).toHaveLength(2)
    expect(() => parseManifest(manifest(targets), { now: NOW, maximumTargets: 1 })).toThrow(
      /above the .* target maximum/
    )
  })

  it('digests the exact bytes', () => {
    const bytes = manifest([{ chainId: 1, token: USDC, eodTimestamp: EOD }])
    const spaced = JSON.stringify(JSON.parse(bytes), null, 2)
    expect(parseManifest(bytes, { now: NOW }).digest).toBe(parseManifest(bytes, { now: NOW }).digest)
    expect(parseManifest(bytes, { now: NOW }).digest).toBe(manifestDigest(bytes))
    expect(parseManifest(spaced, { now: NOW }).digest).not.toBe(parseManifest(bytes, { now: NOW }).digest)
    expect(manifestDigest(Buffer.from(bytes, 'utf8'))).toBe(manifestDigest(bytes))
  })
})
