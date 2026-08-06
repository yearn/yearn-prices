import { neonConfig } from '@neondatabase/serverless'

export function validateLocalDatabaseWsProxy(value: string): string {
  const proxyUrl = new URL(`http://${value}`)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(proxyUrl.hostname)) {
    throw new Error('LOCAL_DATABASE_WS_PROXY must use a loopback host')
  }
  if (proxyUrl.username || proxyUrl.password || proxyUrl.search || proxyUrl.hash) {
    throw new Error('LOCAL_DATABASE_WS_PROXY must not contain credentials, query parameters, or fragments')
  }
  return value
}

const configuredProxy = process.env.LOCAL_DATABASE_WS_PROXY?.trim()

if (configuredProxy) {
  neonConfig.wsProxy = validateLocalDatabaseWsProxy(configuredProxy)
  neonConfig.useSecureWebSocket = false
  neonConfig.pipelineConnect = false
  neonConfig.forceDisablePgSSL = true
}
