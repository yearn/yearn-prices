import { chainNameToId } from '../utils'
import manifest from './write-downs.json'

const entries = new Map<string, (typeof manifest)[number]>()
for (const entry of manifest) {
  const key = `${entry.chain}:${entry.token.toLowerCase()}`
  if (
    entries.has(key) ||
    !Number.isSafeInteger(entry.chain) ||
    entry.chain <= 0 ||
    !/^0x[0-9a-f]{40}$/i.test(entry.token) ||
    !Number.isSafeInteger(entry.from) ||
    entry.from <= 0 ||
    entry.price !== 0 ||
    !entry.reason.trim()
  )
    throw new Error(`Invalid write-down: ${key}`)
  entries.set(key, entry)
}

export function writeDown(chain: string | number, token: string, timestamp: number, source?: string | null) {
  if (source) return null
  const entry = entries.get(`${typeof chain === 'number' ? chain : chainNameToId(chain)}:${token.toLowerCase()}`)
  if (!entry || timestamp < entry.from) return null
  return { price: entry.price, timestamp, symbol: null, confidence: null, source: 'write-down' as const }
}
