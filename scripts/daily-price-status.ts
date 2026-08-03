import { config as loadEnv } from 'dotenv'
import { buildDailyPriceProgressSnapshot, getDailyPriceProgress } from '../src/daily-prices'
import { createPool } from '../src/db'

loadEnv()

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const pool = createPool(databaseUrl, process.env.DATABASE_SCHEMA)
try {
  const progress = await getDailyPriceProgress(pool)
  console.info(JSON.stringify({
    message: 'daily-price-progress',
    ...buildDailyPriceProgressSnapshot(progress, null),
  }, null, 2))
} finally {
  await pool.end()
}
