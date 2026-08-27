import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitRevision, toolVersion } from '../../src/backfill/provenance'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

const mockedExecSync = vi.mocked(execSync)

afterEach(() => {
  mockedExecSync.mockClear()
})

describe('toolVersion', () => {
  it('returns the version field from package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string
    }

    expect(toolVersion()).toBe(pkg.version)
  })
})

describe('gitRevision', () => {
  it('returns HEAD as a 40-character lowercase hex sha', () => {
    const expected = execSync('git rev-parse HEAD', { cwd: import.meta.dirname })
      .toString()
      .trim()

    expect(gitRevision()).toBe(expected)
    expect(gitRevision()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('resolves the same sha regardless of the process working directory', () => {
    const expected = gitRevision()
    const originalCwd = process.cwd()

    try {
      process.chdir(tmpdir())
      expect(gitRevision()).toBe(expected)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('returns null instead of throwing when git cannot resolve a revision', () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error('not a git repository')
    })

    expect(gitRevision()).toBeNull()
  })
})
