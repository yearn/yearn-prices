export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

export async function runInGroups<T>(
  items: T[],
  size: number,
  delayMs: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (const group of chunk(items, size)) {
    const results = await Promise.allSettled(group.map((item) => worker(item)))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`worker crashed: ${String(result.reason)}`)
      }
    }
    if (delayMs > 0 && group.length === size) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}
