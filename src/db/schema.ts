import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar
} from 'drizzle-orm/pg-core'

export const backfillProgress = pgTable('backfill_progress', {
  tokenKey: text('token_key').primaryKey().notNull(),
  doneAt: timestamp('done_at', { withTimezone: true, mode: 'string' }).defaultNow()
})

export const quarantinedTokenPrices = pgTable('quarantined_token_prices', {
  id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
  originalRow: jsonb('original_row').notNull(),
  reason: text().notNull(),
  quarantinedAt: timestamp('quarantined_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
})

export const vaultUnderlyingMap = pgTable(
  'vault_underlying_map',
  {
    chain: text().notNull(),
    vault: text().notNull(),
    underlying: text().notNull()
  },
  (table) => [primaryKey({ columns: [table.vault, table.chain], name: 'vault_underlying_map_pkey' })]
)

export const historicalPriceGapInventory = pgTable(
  'historical_price_gap_inventory',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    token: varchar({ length: 60 }).notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.token, table.timestamp, table.chainId], name: 'historical_price_gap_inventory_pkey' }),
    check('historical_price_gap_inventory_chain_id_check', sql`chain_id > 0`),
    check('historical_price_gap_inventory_token_check', sql`(token)::text ~ '^0x[0-9a-f]{40}$'::text`),
    check('historical_price_gap_inventory_token_check1', sql`(token)::text = lower((token)::text)`),
    check(
      'historical_price_gap_inventory_timestamp_check',
      sql`mod((EXTRACT(epoch FROM "timestamp"))::bigint, (86400)::bigint) = 86399`
    )
  ]
)

export const defillamaRepairRatio = pgTable(
  'defillama_repair_ratio',
  {
    chain: text().notNull(),
    token: text().notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    ratio: numeric().notNull(),
    applied: boolean().default(false).notNull()
  },
  (table) => [primaryKey({ columns: [table.token, table.timestamp, table.chain], name: 'defillama_repair_ratio_pkey' })]
)

export const rejectedPriceObservations = pgTable(
  'rejected_price_observations',
  {
    chain: text().notNull(),
    token: text().notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    source: text().notNull(),
    reason: text().notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.token, table.timestamp, table.source, table.chain],
      name: 'rejected_price_observations_pkey'
    }),
    check('rejected_price_observations_token_check', sql`token = lower(token)`)
  ]
)

export const tokenPrices = pgTable(
  'token_prices',
  {
    chain: varchar({ length: 20 }).notNull(),
    token: varchar({ length: 60 }).notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    price: numeric().notNull(),
    symbol: text(),
    confidence: numeric(),
    source: varchar({ length: 50 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow(),
    finalized: boolean().default(true).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'string' }),
    observationEndpoint: text('observation_endpoint')
  },
  (table) => [
    index('idx_token_prices_range').using(
      'btree',
      table.chain.asc().nullsLast(),
      table.token.asc().nullsLast(),
      table.timestamp.asc().nullsLast()
    ),
    primaryKey({ columns: [table.token, table.timestamp, table.source, table.chain], name: 'token_prices_pkey' }),
    check('token_prices_price_finite_positive', sql`price > 0 AND price::text NOT IN ('NaN', 'Infinity', '-Infinity')`)
  ]
)
