export interface CliSpec {
  options: Set<string>
  flags?: Set<string>
}

export interface CliArgs {
  options: Map<string, string>
  flags: Set<string>
}

export function parseCliArgs(argv: string[], spec: CliSpec): CliArgs {
  const options = new Map<string, string>()
  const flags = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current.startsWith('--')) {
      throw new Error(`unrecognized argument: ${current}`)
    }

    const next = argv[index + 1]
    const hasValue = next !== undefined && !next.startsWith('--')

    if (spec.flags?.has(current)) {
      if (hasValue) {
        throw new Error(`${current} does not take a value`)
      }
      flags.add(current)
      continue
    }

    if (spec.options.has(current)) {
      if (!hasValue) {
        throw new Error(`${current} requires a value`)
      }
      options.set(current, next as string)
      index += 1
      continue
    }

    throw new Error(`unrecognized option: ${current}`)
  }

  return { options, flags }
}
