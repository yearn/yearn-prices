import type { PriceSource } from '../types'
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

/**
 * Durable work queue for closed-day targets that do not yet have an accepted
 * finalized observation. Rows remain until a worker settles them successfully;
 * a lease token prevents a late worker from overwriting a reclaimed attempt.
 */
export const historicalPriceRepairQueue = pgTable(
  'historical_price_repair_queue',
  {
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    token: varchar({ length: 60 }).notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    attempts: bigint({ mode: 'number' }).default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    lastOutcome: varchar('last_outcome', { length: 20 }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' })
  },
  (table) => [
    primaryKey({
      columns: [table.token, table.timestamp, table.chainId],
      name: 'historical_price_repair_queue_pkey'
    }),
    index('historical_price_repair_queue_due_idx')
      .using('btree', table.nextAttemptAt, table.updatedAt)
      .where(sql`completed_at IS NULL`),
    index('historical_price_repair_queue_lease_idx').using('btree', table.leaseExpiresAt),
    check('historical_price_repair_queue_chain_id_check', sql`chain_id > 0`),
    check('historical_price_repair_queue_token_check', sql`(token)::text ~ '^0x[0-9a-f]{40}$'::text`),
    check('historical_price_repair_queue_token_check1', sql`(token)::text = lower((token)::text)`),
    check(
      'historical_price_repair_queue_timestamp_check',
      sql`mod((EXTRACT(epoch FROM "timestamp"))::bigint, (86400)::bigint) = 86399`
    ),
    check('historical_price_repair_queue_attempts_check', sql`attempts >= 0`),
    check(
      'historical_price_repair_queue_outcome_check',
      sql`last_outcome IS NULL OR last_outcome IN ('missing', 'retryable', 'invalid')`
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
    source: varchar({ length: 50 }).$type<PriceSource>().notNull(),
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
    index('idx_token_prices_lower_token').using('btree', table.chain, sql`lower(${table.token})`, table.timestamp),
    primaryKey({ columns: [table.token, table.timestamp, table.source, table.chain], name: 'token_prices_pkey' }),
    check('token_prices_price_finite_positive', sql`price > 0 AND price::text NOT IN ('NaN', 'Infinity', '-Infinity')`)
  ]
)
