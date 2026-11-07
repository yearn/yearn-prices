/** Deployment readiness only: never queries a price provider. */
async function main(): Promise<void> {
  const token = process.env.PRICE_GATEWAY_TOKEN?.trim()
  const rawUrl = process.env.PRICE_GATEWAY_URL
  if (!token || !rawUrl) throw new Error('Gateway URL and token are required for deployment health')
  const endpoint = new URL(rawUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Gateway health requires an HTTPS URL without credentials, query, or fragment')
  }
  endpoint.pathname = '/healthz'
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      })
      if (response.ok && ((await response.json()) as { ok?: boolean }).ok === true) {
        console.log('Provider gateway container is healthy')
        return
      }
      await response.body?.cancel().catch(() => undefined)
    } catch {
      // Containers can take several minutes to provision on their first deploy.
      // Do not log URLs, authorization, or proxy configuration from errors.
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  throw new Error('Provider gateway container did not become healthy within five minutes')
}

void main().catch(() => {
  console.error('Provider gateway deployment health failed; check gateway configuration and Cloudflare rollout status')
  process.exitCode = 1
})
