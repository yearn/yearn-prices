import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
if (tracked.status !== 0) throw new Error('git ls-files failed')

const files = tracked.stdout
  .split('\n')
  .filter(path => /\.(?:ts|js|json|md|toml)$/.test(path))

const failures: string[] = []
for (const path of files) {
  const contents = await readFile(path, 'utf8')
  const lines = contents.split('\n')
  for (const [index, line] of lines.entries()) {
    if (/\s+$/.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`)
  }
  if (!contents.endsWith('\n')) failures.push(`${path}: missing final newline`)
  if (contents.endsWith('\n\n')) failures.push(`${path}: extra blank line at EOF`)
}

const forbidden = tracked.stdout
  .split('\n')
  .filter(path => /(^|\/)(?:\.env|\.dev\.vars)$|\.(?:dump|sql\.gz)$|(^|\/)coverage\//.test(path))
for (const path of forbidden) failures.push(`${path}: forbidden runtime or credential artifact is tracked`)

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.info(`lint: checked ${files.length} tracked text files`)
