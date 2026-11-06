import { chainNameToId } from '../utils'
import manifest from './write-downs.json'

const entries = new Map(manifest.map((entry) => [`${entry.chain}:${entry.token.toLowerCase()}`, entry]))

export function writeDown(chain: string | number, token: string, timestamp: number, source?: string | null) {
  if (source) return null
  const entry = entries.get(`${typeof chain === 'number' ? chain : chainNameToId(chain)}:${token.toLowerCase()}`)
  if (!entry || timestamp < entry.from) return null
  return { price: entry.price, timestamp, symbol: null, confidence: null, source: 'write-down' as const }
}
