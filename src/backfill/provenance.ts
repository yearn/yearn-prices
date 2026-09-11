import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export function toolVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url))
    return (JSON.parse(raw.toString('utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function gitRevision(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: import.meta.dirname })
      .toString()
      .trim()
  } catch {
    return null
  }
}
