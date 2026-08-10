import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Loads .env so live-API integration tests can read a real ENSO_API_KEY,
    // then drops the RPC URLs so no unit test can reach a real node.
    setupFiles: ['./test/setup.ts'],
  },
})
