const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key',
}

export function withCors(headers?: HeadersInit): Headers {
  const merged = new Headers(headers)
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    merged.set(key, value)
  }
  return merged
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: withCors(init?.headers),
  })
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: withCors(),
  })
}
