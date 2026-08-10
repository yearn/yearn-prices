import 'dotenv/config'

// Unit tests must never reach a real node. Tests that exercise on-chain
// pricing inject their own client, so a configured RPC URL here would only
// let a stubbed fetch leak into live calls.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('RPC_URL_')) {
    delete process.env[key]
  }
}
