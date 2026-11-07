/** Bounded, run-owned promise cache. Coalesces concurrent reads; rejected work
 * is evicted so transport errors never become permanent missing observations. */
export class RunCache<T> {
  private readonly entries = new Map<string, Promise<T>>()
  readonly stats = { hits: 0, misses: 0, evictions: 0 }

  constructor(private readonly capacity = 32_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid run cache capacity')
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string, load: () => Promise<T>, retain: (value: T) => boolean = () => true): Promise<T> {
    const existing = this.entries.get(key)
    if (existing) {
      this.stats.hits += 1
      this.entries.delete(key)
      this.entries.set(key, existing)
      return existing
    }
    this.stats.misses += 1
    const pending = Promise.resolve().then(load)
    this.entries.set(key, pending)
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!)
      this.stats.evictions += 1
    }
    void pending.then(
      (value) => {
        if (!retain(value) && this.entries.get(key) === pending) this.entries.delete(key)
      },
      () => {
        if (this.entries.get(key) === pending) this.entries.delete(key)
      }
    )
    return pending
  }
}
