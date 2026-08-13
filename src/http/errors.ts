import type { ErrorBody } from '../types'

export type ErrorCode = 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'INTERNAL_ERROR'

const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500
}

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = ERROR_STATUS[code]
  }
}

export function errorEnvelope<C extends string>(code: C, message: string): ErrorBody<C> {
  return { error: { code, message } }
}

export function jsonError(error: ApiError, headers?: HeadersInit): Response {
  return Response.json(errorEnvelope(error.code, error.message), {
    status: error.status,
    headers
  })
}

export function ensure(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) {
    throw new ApiError(code, message)
  }
}
