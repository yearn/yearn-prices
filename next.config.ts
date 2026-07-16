import type { NextConfig } from 'next'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const nextConfig: NextConfig = {
  // Avoid picking up parent lockfiles when this repo is nested under a larger tree.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url))),
}

export default nextConfig

// Enables Cloudflare bindings (.dev.vars) during `next dev`.
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
initOpenNextCloudflareForDev()
