import { defineCloudflareConfig } from '@opennextjs/cloudflare'

// API-only service: no R2 incremental cache required.
export default defineCloudflareConfig({})
