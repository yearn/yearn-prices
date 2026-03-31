import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadDevVars(): void {
  const devVarsPath = resolve(process.cwd(), '.dev.vars')
  if (!existsSync(devVarsPath)) {
    return
  }

  const content = readFileSync(devVarsPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}
