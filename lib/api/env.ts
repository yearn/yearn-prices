import type { Env } from '@/lib/prices/types'

export type WaitUntil = (promise: Promise<unknown>) => void

export interface RuntimeContext {
  env: Env
  waitUntil: WaitUntil | undefined
}

/**
 * Runtime env + optional waitUntil for the price API.
 *
 * - On Cloudflare Workers (OpenNext): secrets/vars and ExecutionContext come from
 *   getCloudflareContext().
 * - Local `next dev` with initOpenNextCloudflareForDev: same path, backed by .dev.vars.
 * - Unit tests / plain Node scripts: fall back to process.env (no waitUntil).
 */
export async function getRuntimeContext(): Promise<RuntimeContext> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env, ctx } = await getCloudflareContext({ async: true })
    const waitUntil =
      ctx && typeof (ctx as { waitUntil?: WaitUntil }).waitUntil === 'function'
        ? (ctx as { waitUntil: WaitUntil }).waitUntil.bind(ctx)
        : undefined
    return {
      env: env as unknown as Env,
      waitUntil,
    }
  } catch (error) {
    // Only fall back when we are clearly not in a Worker isolate. A throw inside
    // getCloudflareContext on the live Worker must not look like "missing secrets".
    const isWorker =
      typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined' ||
      (typeof caches !== 'undefined' &&
        typeof (caches as unknown as { default?: unknown }).default !== 'undefined')

    if (isWorker) {
      console.error(
        JSON.stringify({
          message: 'cloudflare-context-error',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      throw error
    }

    return {
      env: process.env as unknown as Env,
      waitUntil: undefined,
    }
  }
}

export async function getEnv(): Promise<Env> {
  const { env } = await getRuntimeContext()
  return env
}
