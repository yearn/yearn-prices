import { config as loadEnv } from 'dotenv'
import { createPool } from '../src/db'

loadEnv({ path: '.dev.vars', override: false })

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const pool = createPool(databaseUrl)

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS token_prices (
      chain      VARCHAR(20)  NOT NULL,
      token      VARCHAR(60)  NOT NULL,
      timestamp  TIMESTAMPTZ  NOT NULL,
      price      NUMERIC      NOT NULL,
      symbol     VARCHAR(20),
      confidence NUMERIC,
      source     VARCHAR(50)  NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (chain, token, timestamp, source)
    );
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_token_prices_range
      ON token_prices (chain, token, timestamp);
  `)

  console.info('Migration complete')
} finally {
  await pool.end()
}
