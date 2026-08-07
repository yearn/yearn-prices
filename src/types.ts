export const SOURCE_PRIORITY = [
  'defillama',
  'on-chain-oracle',
  'bobs-api',
  'curve',
  'derived',
  'enso',
] as const

export type PriceSource = (typeof SOURCE_PRIORITY)[number]

export interface Env {
  DATABASE_URL: string
  ENSO_API_KEY?: string
  [key: string]: string | undefined
}

export interface ParsedTokenKey {
  chain: string
  token: `0x${string}`
  tokenKey: string
}

export interface DbPriceRow {
  chain: string
  token: string
  timestamp: string | Date
  price: string | number
  symbol: string | null
  confidence: string | number | null
  source: PriceSource
}

export interface PricePoint {
  timestamp: number
  price: number
  confidence: number | null
  source: PriceSource
}

export interface ExactPriceRecord extends PricePoint {
  chain: string
  token: string
  symbol: string | null
}

export interface HistoricalRequestTuple {
  chain: string
  token: string
  timestamp: number
}

export interface SpotRequest {
  chain: string
  token: `0x${string}`
  originalKey: string
}

export interface RangeRequest {
  chain: string
  token: string
  startTimestamp: number
  endTimestamp: number
}

export interface HistoricalResponseCoin {
  price: number
  symbol: string | null
  timestamp: number
  confidence: number | null
  source: PriceSource
}

export interface BatchHistoricalResponseCoin {
  symbol: string | null
  prices: PricePoint[]
}

export interface ErrorPayload<C extends string = string> {
  code: C
  message: string
}

export type ErrorBody<C extends string = string> = {
  error: ErrorPayload<C>
}

export type SpotTokenErrorCode = 'NOT_FOUND' | 'UNAVAILABLE'

export type SpotErrorResponseCoin = ErrorBody<SpotTokenErrorCode>

export type SpotResponseCoin =
  | {
      symbol: string | null
      prices: Array<{
        timestamp: number
        price: number
        confidence: number | null
        source: string
      }>
    }
  | SpotErrorResponseCoin

export interface TokenPriceWrite {
  chain: string
  token: string
  timestamp: number
  price: number | string
  symbol: string | null
  confidence: number | string | null
  source: PriceSource
}

export interface KongVaultListItem {
  chainId: number
  address: string
  symbol: string | null
  apiVersion: string | null
  decimals: number | null
  asset?: {
    address: string
    symbol?: string | null
    decimals?: number | null
  } | null
}

export interface DefiLlamaHistoricalCoin {
  price: number
  symbol?: string
  timestamp: number
  confidence?: number | null
  decimals?: number
}

export interface DefiLlamaHistoricalResponse {
  coins: Record<string, DefiLlamaHistoricalCoin>
}

export interface DefiLlamaBatchCoin {
  symbol?: string
  prices: Array<{
    timestamp: number
    price: number
    confidence?: number | null
  }>
}

export interface DefiLlamaBatchResponse {
  coins: Record<string, DefiLlamaBatchCoin>
}

export interface EnsoPriceResponse {
  decimals: number
  price: number
  address: string
  chainId: number
  symbol?: string
  timestamp?: number
  confidence?: number
}
