import { describe, expect, test } from 'vitest'
import { handleDailyPriceDashboardAsset } from '../src/daily-price-dashboard-page'
import worker from '../src/index'
import type { Env } from '../src/types'

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext

describe('daily price dashboard page', () => {
  test('serves the dashboard shell publicly with a restrictive content policy', async () => {
    const response = await worker.fetch(
      new Request('https://prices.local/daily-prices'),
      {} as Env,
      executionContext,
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).toContain('Daily prices')
    expect(html).toContain('/daily-prices/app.js')
    expect(html).not.toContain('API_KEY_')
  })

  test('keeps progress data authenticated', async () => {
    const response = await worker.fetch(
      new Request('https://prices.local/api/daily-prices/progress'),
      { DATABASE_URL: 'postgres://unused' } as Env,
      executionContext,
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Missing API key' },
    })
  })

  test('stores credentials only for the browser tab and sends bearer auth', async () => {
    const response = handleDailyPriceDashboardAsset('/daily-prices/app.js', 'GET')
    const script = await response?.text()

    expect(script).toContain('sessionStorage.setItem')
    expect(script).toContain("authorization: 'Bearer ' + apiKey")
    expect(script).not.toContain('localStorage')
    expect(script).not.toContain('API_KEY_')
  })

  test('serves responsive, reduced-motion styles without pure black or white', async () => {
    const response = handleDailyPriceDashboardAsset('/daily-prices/styles.css', 'GET')
    const css = await response?.text()

    expect(css).toContain('@media (max-width: 480px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('oklch(')
    expect(css).not.toMatch(/#(?:000|000000|fff|ffffff)\\b/i)
  })
})
