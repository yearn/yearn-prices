import { HttpRequestError } from '../clients/http-client'

export function httpDiagnosticCodes(error: unknown): string[] {
  if (error instanceof HttpRequestError) {
    return [error.attempts > 1 ? 'retry_exhausted' : 'provider_rejected', error.diagnosticCode]
  }
  if (error instanceof SyntaxError) {
    return ['invalid_json']
  }
  return ['retry_exhausted']
}

export function httpAttempts(error: unknown): number {
  if (error instanceof HttpRequestError) {
    return error.attempts
  }
  return 1
}
