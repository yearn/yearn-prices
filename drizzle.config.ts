import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  tablesFilter: ['!migrations'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL as string }
})
