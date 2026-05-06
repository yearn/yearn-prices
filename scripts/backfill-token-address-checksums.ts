import { config as loadEnv } from 'dotenv'
loadEnv()
import { getAddress } from 'viem'
import { createPool } from '../src/db'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

interface Args {
  batchSize: number
  dryRun: boolean
}

interface BackfillStats {
  addresses: number
  invalid: number
  unchanged: number
  mappings: number
  copied: number
  deleted: number
}

function parseArgs(argv: string[]): Args {
  const options = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = argv[index + 1]
    if (current === '--dry-run') {
      options.set(current, true)
      continue
    }

    if (current.startsWith('--') && next) {
      options.set(current, next)
      index += 1
    }
  }

  const rawBatchSize = options.get('--batch-size')
  const batchSize = typeof rawBatchSize === 'string' ? Number(rawBatchSize) : 100
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('--batch-size must be a positive integer')
  }

  return {
    batchSize,
    dryRun: options.get('--dry-run') === true,
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

const pool = createPool(databaseUrl)

try {
  const args = parseArgs(process.argv.slice(2))
  const stats: BackfillStats = {
    addresses: 0,
    invalid: 0,
    unchanged: 0,
    mappings: 0,
    copied: 0,
    deleted: 0,
  }

  const result = await pool.query<{ token: string }>('SELECT DISTINCT token FROM token_prices ORDER BY token')
  stats.addresses = result.rows.length
  console.info(`Fetched ${stats.addresses} unique token addresses`)

  const mappings = new Map<string, string>()
  for (const [index, row] of result.rows.entries()) {
    try {
      const checksummed = getAddress(row.token)
      if (checksummed === row.token) {
        stats.unchanged += 1
        continue
      }

      mappings.set(row.token, checksummed)
    } catch {
      stats.invalid += 1
      console.warn(`skip:invalid-token ${row.token}`)
    }

    if ((index + 1) % 1_000 === 0 || index + 1 === result.rows.length) {
      console.info(
        `Scanned ${index + 1}/${result.rows.length} addresses: ${mappings.size} need updates, ${stats.unchanged} unchanged, ${stats.invalid} invalid`,
      )
    }
  }

  stats.mappings = mappings.size
  if (args.dryRun || mappings.size === 0) {
    console.info(JSON.stringify({ message: 'token-address-checksum-backfill', dryRun: args.dryRun, ...stats }))
  } else {
    const mappingBatches = chunk([...mappings.entries()], args.batchSize)
    console.info(`Starting backfill for ${mappings.size} address mappings in ${mappingBatches.length} batches`)

    for (const [batchIndex, mappingBatch] of mappingBatches.entries()) {
      const valuesSql: string[] = []
      const params: string[] = []

      for (const [oldToken, newToken] of mappingBatch) {
        const offset = params.length
        valuesSql.push(`($${offset + 1}, $${offset + 2})`)
        params.push(oldToken, newToken)
      }

      await pool.query('BEGIN')
      try {
        console.info(`Batch ${batchIndex + 1}/${mappingBatches.length}: updating ${mappingBatch.length} address mappings`)
        const backfill = await pool.query<{ copied: string; deleted: string }>(
          `
            WITH mappings(old_token, new_token) AS (
              VALUES ${valuesSql.join(', ')}
            ),
            copied AS (
              INSERT INTO token_prices (chain, token, timestamp, price, symbol, confidence, source, created_at)
              SELECT
                tp.chain,
                mappings.new_token,
                tp.timestamp,
                tp.price,
                tp.symbol,
                tp.confidence,
                tp.source,
                tp.created_at
              FROM token_prices tp
              INNER JOIN mappings
                ON tp.token = mappings.old_token
              WHERE mappings.old_token <> mappings.new_token
              ON CONFLICT (chain, token, timestamp, source) DO NOTHING
              RETURNING 1
            ),
            deleted AS (
              DELETE FROM token_prices tp
              USING mappings
              WHERE tp.token = mappings.old_token
                AND mappings.old_token <> mappings.new_token
              RETURNING 1
            )
            SELECT
              (SELECT COUNT(*) FROM copied) AS copied,
              (SELECT COUNT(*) FROM deleted) AS deleted
          `,
          params,
        )

        await pool.query('COMMIT')
        const copied = Number(backfill.rows[0]?.copied ?? 0)
        const deleted = Number(backfill.rows[0]?.deleted ?? 0)
        stats.copied += copied
        stats.deleted += deleted
        console.info(
          `Batch ${batchIndex + 1}/${mappingBatches.length} complete: copied ${copied}, deleted ${deleted}, cumulative copied ${stats.copied}, deleted ${stats.deleted}`,
        )
      } catch (error) {
        await pool.query('ROLLBACK')
        console.error(`Batch ${batchIndex + 1}/${mappingBatches.length} failed; transaction rolled back`)
        throw error
      }
    }

    console.info(JSON.stringify({ message: 'token-address-checksum-backfill', dryRun: false, ...stats }))
  }
} finally {
  await pool.end()
}
