const signalIds = new WeakMap<AbortSignal, number>()
let nextSignalId = 1

export function signalKey(signal?: AbortSignal): string {
  if (!signal) {
    return 'none'
  }

  const cached = signalIds.get(signal)
  if (cached !== undefined) {
    return String(cached)
  }

  const id = nextSignalId
  nextSignalId += 1
  signalIds.set(signal, id)
  return String(id)
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
