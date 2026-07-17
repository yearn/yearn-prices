import { normalizeTokenKey } from './chains'

// Legacy Curve LP tokens where DefiLlama stores garbage (price = 0 and/or
// multi-million spikes) that outranks the Curve virtual-price fallback.
// Enumerated from production token_prices: source=defillama AND
// (price<=0 OR price>1e6) AND a curve-source row exists for the same token.
//
// These are classic stableswap-registry LPs, so priceCurveLpUsd can replace them.
const BAD_DEFILLAMA_CURVE_LPS = [
  // Curve Y pool — all-zero DefiLlama history in DB (~901 rows)
  ['ethereum', '0xdF5e0e81Dff6FAF3A7e52BA697820c5e32D806A8'], // yDAI+yUSDC+yUSDT+yTUSD
  // Curve yBUSD pool — zeros + ~7e7 spikes (~920 rows)
  ['ethereum', '0x3B3Ac5386837Dc563660FB6a0937DFAa5924333B'], // yDAI+yUSDC+yUSDT+yBUSD
  // Curve PAX pool — zeros + ~2e6 spikes (~916 rows)
  ['ethereum', '0xD905e2eaeBe188fc92179b6350807D8bd91Db0D8'], // ypaxCrv
  // Curve sUSD plain3 — all-zero DefiLlama (~329 rows)
  ['ethereum', '0xC25a3A3b969415c80451098fa907EC722572917F'], // crvPlain3andSUSD
] as const

export const BAD_DEFILLAMA_TOKEN_KEYS: ReadonlySet<string> = new Set(
  BAD_DEFILLAMA_CURVE_LPS.map(([chain, token]) => normalizeTokenKey(chain, token)),
)

export function isBadDefiLlamaToken(chain: string, token: string): boolean {
  try {
    return BAD_DEFILLAMA_TOKEN_KEYS.has(normalizeTokenKey(chain, token))
  } catch {
    return false
  }
}

export function isBadDefiLlamaTokenKey(tokenKey: string): boolean {
  const separatorIndex = tokenKey.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === tokenKey.length - 1) {
    return false
  }
  return isBadDefiLlamaToken(tokenKey.slice(0, separatorIndex), tokenKey.slice(separatorIndex + 1))
}
