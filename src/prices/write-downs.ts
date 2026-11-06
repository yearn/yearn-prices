import { chainNameToId } from '../utils'
import manifest from './write-downs.json'

export function loadWriteDowns(manifestEntries: typeof manifest) {
  const entries = new Map<string, (typeof manifest)[number]>()
  for (const entry of manifestEntries) {
    const key = `${entry.chain}:${entry.token.toLowerCase()}`
    if (
      entries.has(key) ||
      !Number.isSafeInteger(entry.chain) ||
      entry.chain <= 0 ||
      !/^0x[0-9a-f]{40}$/.test(entry.token) ||
      !Number.isSafeInteger(entry.from) ||
      entry.from <= 0 ||
      !entry.reason.trim()
    )
      throw new Error(`Invalid write-down: ${key}`)
    entries.set(key, entry)
  }

  return entries
}

const entries = loadWriteDowns(manifest)

export function writeDown(chain: string | number, token: string, timestamp: number, source?: string | null) {
  if (source) return null
  const entry = entries.get(`${typeof chain === 'number' ? chain : chainNameToId(chain)}:${token.toLowerCase()}`)
  if (!entry || timestamp < entry.from) return null
  return { price: 0, timestamp, symbol: null, confidence: null, source: 'write-down' as const }
}
