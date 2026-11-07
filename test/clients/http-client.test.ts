import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchJsonWithRetry,
  HttpRequestError,
  MAX_PROVIDER_COOLDOWN_MS,
  parseRetryAfter,
  SharedCooldownRateLimiter,
  SlidingWindowRateLimiter
} from '../../src/clients/http-client'
import { ApiError } from '../../src/http/errors'

const URL_UNDER_TEST = 'https://provider.test/prices'

function limiter(): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(100, 1000)
}

function stubFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) {
      throw new Error('unexpected extra fetch call')
    }
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function drain<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  while (!done) {
    await vi.advanceTimersByTimeAsync(1000)
  }
  return work
}

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

function bodyFailure(error: Error): Response {
  const response = new Response('{}', { status: 200 })
  response.json = () => Promise.reject(error)
  return response
}

describe('fetchJsonWithRetry compatibility for callers passing no options', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('calls fetch with no init when there are no headers and no timeout', async () => {
    const fetchMock = stubFetch(Response.json({ ok: true }))

    await fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter() })

    expect(fetchMock.mock.calls[0][1]).toBeUndefined()
  })

  it('keeps the fixed backoff and three-attempt bound for retryable statuses', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(
      Response.json({}, { status: 500 }),
      Response.json({}, { status: 503 }),
      Response.json({}, { status: 500 })
    )
    const onRetry = vi.fn()

    await expect(
      drain(fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter(), onRetry }))
    ).rejects.toThrow('Test request failed with status 500')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onRetry.mock.calls.map((call) => call[1])).toEqual([1000, 2000])
  })

  it('ignores Retry-After unless the caller opts in', async () => {
    vi.useFakeTimers()
    stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': '5' } }), Response.json({ ok: true }))
    const onRetry = vi.fn()

    await drain(fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter(), onRetry }))

    expect(onRetry.mock.calls[0][1]).toBe(1000)
  })

  it('propagates a transport failure without retrying', async () => {
    const fetchMock = stubFetch(named('TypeError', 'socket hang up'))

    await expect(fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter() })).rejects.toThrow(
      'socket hang up'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propagates a malformed JSON body without retrying', async () => {
    const fetchMock = stubFetch(new Response('not json', { status: 200 }))

    await expect(
      fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter() })
    ).rejects.toBeInstanceOf(SyntaxError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propagates a body-read failure without retrying', async () => {
    const fetchMock = stubFetch(bodyFailure(named('TimeoutError', 'The operation was aborted due to timeout')))

    await expect(fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter() })).rejects.toMatchObject(
      { name: 'TimeoutError' }
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still throws a typed ApiError for a failed provider response', async () => {
    stubFetch(Response.json({}, { status: 400 }))

    await expect(
      fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter() })
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('still maps 404 to NOT_FOUND when notFoundAsError is set', async () => {
    stubFetch(Response.json({}, { status: 404 }))

    await expect(
      fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter(), notFoundAsError: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('12', 60_000)).toBe(12_000)
  })

  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-08-19T00:00:00.000Z')
    expect(parseRetryAfter('Wed, 19 Aug 2026 00:00:30 GMT', 60_000, now)).toBe(30_000)
  })

  it('clamps a past HTTP-date to zero', () => {
    const now = Date.parse('2026-08-19T00:01:00.000Z')
    expect(parseRetryAfter('Wed, 19 Aug 2026 00:00:00 GMT', 60_000, now)).toBe(0)
  })

  it('caps a long delay', () => {
    expect(parseRetryAfter('9999', 60_000)).toBe(60_000)
  })

  it('rejects invalid and empty values', () => {
    expect(parseRetryAfter('soon', 60_000)).toBeNull()
    expect(parseRetryAfter('  ', 60_000)).toBeNull()
    expect(parseRetryAfter(null, 60_000)).toBeNull()
  })
})

describe('fetchJsonWithRetry opt-in hardening', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('honors a Retry-After delta-seconds header', async () => {
    vi.useFakeTimers()
    stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': '3' } }), Response.json({ ok: true }))
    const onRetry = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        onRetry,
        honorRetryAfter: true
      })
    )

    expect(onRetry.mock.calls[0][1]).toBe(3000)
  })

  it('can surface the first rate limit without retrying', async () => {
    const fetchMock = stubFetch(Response.json({}, { status: 429 }), Response.json({ ok: true }))

    await expect(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        retryRateLimits: false
      })
    ).rejects.toMatchObject({ responseStatus: 429, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors a Retry-After HTTP-date header', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    stubFetch(
      Response.json({}, { status: 503, headers: { 'retry-after': 'Wed, 19 Aug 2026 00:00:04 GMT' } }),
      Response.json({ ok: true })
    )
    const onRetry = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        onRetry,
        honorRetryAfter: true
      })
    )

    expect(onRetry.mock.calls[0][1]).toBe(4000)
  })

  it('falls back to the fixed backoff for an invalid Retry-After header', async () => {
    vi.useFakeTimers()
    stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': 'tomorrow' } }), Response.json({ ok: true }))
    const onRetry = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        onRetry,
        honorRetryAfter: true
      })
    )

    expect(onRetry.mock.calls[0][1]).toBe(1000)
  })

  it('caps a long Retry-After delay', async () => {
    vi.useFakeTimers()
    stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': '600' } }), Response.json({ ok: true }))
    const onRetry = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        onRetry,
        honorRetryAfter: true,
        retryAfterCapMs: 5_000
      })
    )

    expect(onRetry.mock.calls[0][1]).toBe(5000)
  })

  it('passes an abort signal when a request timeout is configured', async () => {
    const fetchMock = stubFetch(Response.json({ ok: true }))

    await fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter(), timeoutMs: 5_000 })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it('aborts a hanging request once the timeout elapses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })
      )
    )

    await expect(
      fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter: limiter(), timeoutMs: 5 })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('retries a transport failure and reports the transport diagnostic code', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(
      named('TypeError', 'socket hang up'),
      named('TypeError', 'getaddrinfo ENOTFOUND'),
      named('TypeError', 'socket hang up')
    )

    const error = await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        retryTransportErrors: true
      }).catch((thrown) => thrown)
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(error).toBeInstanceOf(HttpRequestError)
    expect(error).toMatchObject({ diagnosticCode: 'transport', attempts: 3 })
  })

  it('classifies an aborted request as a timeout', async () => {
    vi.useFakeTimers()
    stubFetch(
      named('TimeoutError', 'The operation was aborted due to timeout'),
      named('TimeoutError', 'The operation was aborted due to timeout'),
      named('TimeoutError', 'The operation was aborted due to timeout')
    )

    const error = await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        retryTransportErrors: true
      }).catch((thrown) => thrown)
    )

    expect(error).toMatchObject({ diagnosticCode: 'timeout' })
  })

  it('retries a malformed JSON body and recovers', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(new Response('not json', { status: 200 }), Response.json({ ok: true }))

    const result = await drain(
      fetchJsonWithRetry<{ ok: boolean }>(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        retryInvalidJson: true
      })
    )

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports invalid JSON with its own diagnostic code once retries are exhausted', async () => {
    vi.useFakeTimers()
    stubFetch(
      new Response('not json', { status: 200 }),
      new Response('not json', { status: 200 }),
      new Response('not json', { status: 200 })
    )

    const error = await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        retryInvalidJson: true
      }).catch((thrown) => thrown)
    )

    expect(error).toMatchObject({ diagnosticCode: 'invalid_json', attempts: 3 })
  })

  it('classifies a timeout during the body read as a timeout, not invalid JSON', async () => {
    vi.useFakeTimers()
    const timeout = named('TimeoutError', 'The operation was aborted due to timeout')
    const fetchMock = stubFetch(bodyFailure(timeout), bodyFailure(timeout), bodyFailure(timeout))

    const error = await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        timeoutMs: 30_000,
        retryTransportErrors: true,
        retryInvalidJson: true
      }).catch((thrown) => thrown)
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(error).toBeInstanceOf(HttpRequestError)
    expect(error).toMatchObject({ diagnosticCode: 'timeout', attempts: 3 })
  })

  it('retries a body-read transport failure even when invalid JSON retries are off', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(bodyFailure(named('TypeError', 'terminated')), Response.json({ ok: true }))

    const result = await drain(
      fetchJsonWithRetry<{ ok: boolean }>(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        timeoutMs: 30_000,
        retryTransportErrors: true
      })
    )

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never backs off less than the fixed delay when Retry-After is zero', async () => {
    vi.useFakeTimers()
    stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': '0' } }), Response.json({ ok: true }))
    const onRetry = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        honorRetryAfter: true,
        onRetry
      })
    )

    expect(onRetry.mock.calls[0][1]).toBe(1000)
  })

  it('reports every 429 Retry-After, including the exhausted attempt', async () => {
    vi.useFakeTimers()
    stubFetch(
      Response.json({}, { status: 429, headers: { 'retry-after': '1' } }),
      Response.json({}, { status: 429, headers: { 'retry-after': '2' } }),
      Response.json({}, { status: 429, headers: { 'retry-after': '90000' } })
    )
    const onRetry = vi.fn()
    const onRateLimit = vi.fn()

    await drain(
      fetchJsonWithRetry(URL_UNDER_TEST, {
        service: 'Test',
        rateLimiter: limiter(),
        onRetry,
        onRateLimit,
        honorRetryAfter: true,
        retryAfterCapMs: Number.MAX_SAFE_INTEGER
      }).catch((error) => error)
    )

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRateLimit.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 90_000_000])
  })

  it('cancels while waiting for a rate limiter turn without making another request', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(Response.json({ ok: true }), Response.json({ ok: true }))
    const rateLimiter = new SlidingWindowRateLimiter(1, 1000)
    await fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter })

    const controller = new AbortController()
    const reason = new Error('caller stopped waiting')
    const pending = fetchJsonWithRetry(URL_UNDER_TEST, { service: 'Test', rateLimiter, signal: controller.signal })
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels retry backoff and preserves caller cancellation alongside timeout', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(Response.json({}, { status: 429, headers: { 'retry-after': '30' } }))
    const controller = new AbortController()
    const reason = new Error('request no longer needed')
    const pending = fetchJsonWithRetry(URL_UNDER_TEST, {
      service: 'Test',
      rateLimiter: limiter(),
      honorRetryAfter: true,
      timeoutMs: 60_000,
      signal: controller.signal
    })

    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a failed provider response with the provider diagnostic code', async () => {
    stubFetch(Response.json({}, { status: 400 }))

    const error = await fetchJsonWithRetry(URL_UNDER_TEST, {
      service: 'Test',
      rateLimiter: limiter(),
      retryTransportErrors: true,
      honorRetryAfter: true
    }).catch((thrown) => thrown)

    expect(error).toMatchObject({ diagnosticCode: 'provider_response', responseStatus: 400 })
  })
})

it('reopens a shared gate after the operational ceiling', async () => {
  vi.useFakeTimers()
  try {
    const gate = new SharedCooldownRateLimiter(10, 1000, 0)
    gate.extendCooldown(60_000_000)
    await expect(gate.waitTurn()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(MAX_PROVIDER_COOLDOWN_MS)
    await expect(gate.waitTurn()).resolves.toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})
