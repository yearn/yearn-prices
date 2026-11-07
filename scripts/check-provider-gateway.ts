/** Deployment readiness only: never queries a price provider. */
async function main(): Promise<void> {
  const token = process.env.PRICE_GATEWAY_TOKEN?.trim()
  const rawUrl = process.env.PRICE_GATEWAY_URL
  const revision = process.env.EXPECTED_GATEWAY_REVISION
  if (!token || !rawUrl || !revision)
    throw new Error('Gateway URL, token, and revision are required for deployment health')
  const endpoint = new URL(rawUrl)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Gateway health requires an HTTPS URL without credentials, query, or fragment')
  }
  endpoint.pathname = '/readyz'
  // Replacement provisioning has taken about eight minutes in production.
  // Leave room inside the CI job for image build, deploy and this bounded wait.
  const started = Date.now()
  const deadline = started + 15 * 60_000
  let lastObservation = 'no response'
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const response = await fetch(endpoint, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      })
      lastObservation = `HTTP ${response.status}`
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean; revision?: string }
        if (body.ok === true && body.revision === revision) {
          console.log('Provider gateway container is healthy and serving the requested revision')
          return
        }
        lastObservation = body.ok === true ? 'container revision does not match deployment' : 'container is not ready'
      }
      await response.body?.cancel().catch(() => undefined)
    } catch {
      lastObservation = 'request timed out, failed, or returned invalid JSON'
      // Both first deployments and replacements can take several minutes.
      // Do not log URLs, authorization, or proxy configuration from errors.
    }
    console.log(
      `Gateway readiness attempt ${attempts}: ${lastObservation}; elapsed ${Math.round((Date.now() - started) / 1000)}s`
    )
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(0, deadline - Date.now()))))
  }
  console.error(`Gateway did not become ready within 15 minutes; last observation: ${lastObservation}`)
  throw new Error('Provider gateway readiness deadline exceeded')
}

void main().catch(() => {
  console.error('Provider gateway deployment health failed; check gateway configuration and Cloudflare rollout status')
  process.exitCode = 1
})
