import { describe, expect, test } from 'vitest'
import { authenticateRequest, requireDailyPriceOperator } from '../src/auth'
import { ApiError } from '../src/errors'

describe('API key authorization', () => {
  test('keeps application keys read-only', () => {
    const client = authenticateRequest(
      new Request('https://prices.local/api/prices/batchHistorical', {
        headers: { authorization: 'Bearer frontend-key' },
      }),
      { DATABASE_URL: 'postgres://unused', API_KEY_FRONTEND: 'frontend-key' },
    )

    expect(client).toEqual({ clientId: 'frontend', access: 'read' })
    expect(() => requireDailyPriceOperator(client)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }) as ApiError,
    )
  })

  test('grants queue mutation permission only to the dedicated operator key', () => {
    const client = authenticateRequest(
      new Request('https://prices.local/api/daily-prices/requeue', {
        headers: { 'x-api-key': 'operator-key' },
      }),
      {
        DATABASE_URL: 'postgres://unused',
        API_KEY_FRONTEND: 'frontend-key',
        DAILY_PRICE_OPERATOR_API_KEY: 'operator-key',
      },
    )

    expect(client).toEqual({ clientId: 'daily-price-operator', access: 'operator' })
    expect(() => requireDailyPriceOperator(client)).not.toThrow()
  })
})
