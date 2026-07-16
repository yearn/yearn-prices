import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Loads .env so live-API integration tests can read a real ENSO_API_KEY.
    setupFiles: ['dotenv/config'],
  },
})
